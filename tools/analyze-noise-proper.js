#!/usr/bin/env node
/**
 * Proper Audio Level Analysis for Noise Gate Threshold
 *
 * For orchestral recordings, mean level is useless because instruments
 * rest for long periods. Instead, we analyze the DISTRIBUTION of levels
 * to find:
 *   1. Noise floor cluster (during rests)
 *   2. Signal cluster (during playing)
 *   3. The gap between them (where threshold should go)
 *
 * Uses 100ms windows to capture momentary loudness.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WINDOW_MS = 100;  // 100ms windows for momentary analysis
const CURRENT_THRESHOLD = -48;

/**
 * Get per-window RMS levels using ffmpeg astats
 */
function getWindowLevels(filePath, windowMs = WINDOW_MS) {
  // Get sample rate first
  const probeResult = execSync(
    `ffprobe -v quiet -print_format json -show_streams "${filePath}"`,
    { encoding: 'utf8' }
  );
  const probe = JSON.parse(probeResult);
  const sampleRate = parseInt(probe.streams[0]?.sample_rate || 44100);
  const windowSamples = Math.floor(sampleRate * windowMs / 1000);

  // Use astats to get per-window RMS
  // The reset parameter causes stats to reset every N samples
  const result = execSync(
    `ffmpeg -i "${filePath}" -af "astats=metadata=1:reset=${windowSamples}" -f null - 2>&1`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );

  // Parse RMS levels
  const levels = [];
  const rmsMatches = result.matchAll(/RMS level dB:\s*([-\d.]+|-inf)/g);
  for (const match of rmsMatches) {
    const level = match[1] === '-inf' ? -100 : parseFloat(match[1]);
    if (!isNaN(level) && level > -100) {
      levels.push(level);
    }
  }

  // Also try Peak level if RMS is sparse
  if (levels.length < 10) {
    const peakMatches = result.matchAll(/Peak level dB:\s*([-\d.]+|-inf)/g);
    for (const match of peakMatches) {
      const level = match[1] === '-inf' ? -100 : parseFloat(match[1]);
      if (!isNaN(level) && level > -100) {
        levels.push(level);
      }
    }
  }

  return levels;
}

/**
 * Alternative: Use EBU R128 momentary loudness (400ms windows)
 */
function getEbuLoudness(filePath) {
  try {
    const result = execSync(
      `ffmpeg -i "${filePath}" -af "ebur128=metadata=1:peak=true" -f null - 2>&1`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );

    const levels = [];
    // Parse momentary loudness values (M:)
    const matches = result.matchAll(/M:\s*([-\d.]+)/g);
    for (const match of matches) {
      const level = parseFloat(match[1]);
      if (!isNaN(level) && level > -70) {
        levels.push(level);
      }
    }
    return levels;
  } catch (e) {
    return [];
  }
}

/**
 * Build histogram of levels
 */
function buildHistogram(levels, binSize = 1) {
  const histogram = {};
  for (const level of levels) {
    const bin = Math.floor(level / binSize) * binSize;
    histogram[bin] = (histogram[bin] || 0) + 1;
  }
  return histogram;
}

/**
 * Find clusters in the distribution (noise floor vs signal)
 */
function findClusters(levels) {
  const sorted = [...levels].sort((a, b) => a - b);
  const n = sorted.length;

  if (n < 20) {
    return { noiseFloor: null, signalLevel: null, gap: null };
  }

  // Percentiles
  const p5 = sorted[Math.floor(n * 0.05)];
  const p10 = sorted[Math.floor(n * 0.10)];
  const p25 = sorted[Math.floor(n * 0.25)];
  const p50 = sorted[Math.floor(n * 0.50)];
  const p75 = sorted[Math.floor(n * 0.75)];
  const p90 = sorted[Math.floor(n * 0.90)];
  const p95 = sorted[Math.floor(n * 0.95)];

  // Build 1dB histogram
  const histogram = buildHistogram(levels, 1);
  const bins = Object.keys(histogram).map(Number).sort((a, b) => a - b);

  // Find valleys (gaps) in the histogram
  // A gap is where count drops significantly
  let maxGapStart = null;
  let maxGapEnd = null;
  let maxGapSize = 0;

  for (let i = 0; i < bins.length - 1; i++) {
    const gap = bins[i + 1] - bins[i];
    if (gap > maxGapSize && gap > 3) {  // At least 3dB gap
      maxGapSize = gap;
      maxGapStart = bins[i];
      maxGapEnd = bins[i + 1];
    }
  }

  // Noise floor: average of bottom 10% of samples
  const noiseFloorSamples = sorted.slice(0, Math.floor(n * 0.1));
  const noiseFloor = noiseFloorSamples.reduce((a, b) => a + b, 0) / noiseFloorSamples.length;

  // Signal level: average of top 25% of samples (when instrument is clearly playing)
  const signalSamples = sorted.slice(Math.floor(n * 0.75));
  const signalLevel = signalSamples.reduce((a, b) => a + b, 0) / signalSamples.length;

  return {
    noiseFloor,
    signalLevel,
    gap: maxGapSize > 3 ? { start: maxGapStart, end: maxGapEnd, size: maxGapSize } : null,
    percentiles: { p5, p10, p25, p50, p75, p90, p95 },
    histogram,
  };
}

/**
 * Analyze a single file
 */
function analyzeFile(filePath) {
  const fileName = path.basename(filePath);
  process.stdout.write(`Analyzing ${fileName}... `);

  // Try astats first
  let levels = getWindowLevels(filePath);

  // If that didn't work well, try EBU R128
  if (levels.length < 50) {
    const ebuLevels = getEbuLoudness(filePath);
    if (ebuLevels.length > levels.length) {
      levels = ebuLevels;
    }
  }

  if (levels.length < 20) {
    console.log('insufficient data');
    return null;
  }

  const analysis = findClusters(levels);
  console.log(`${levels.length} windows analyzed`);

  return {
    fileName,
    windowCount: levels.length,
    ...analysis,
  };
}

/**
 * Print visual histogram
 */
function printHistogram(histogram, threshold) {
  const bins = Object.keys(histogram).map(Number).sort((a, b) => a - b);
  const maxCount = Math.max(...Object.values(histogram));
  const barWidth = 50;

  console.log('\n  dB     | Distribution');
  console.log('  -------|' + '-'.repeat(barWidth + 10));

  for (const bin of bins) {
    const count = histogram[bin];
    const barLen = Math.round((count / maxCount) * barWidth);
    const bar = '█'.repeat(barLen);
    const marker = bin === Math.floor(threshold) ? ' ← THRESHOLD' : '';
    const binLabel = bin.toString().padStart(4);
    console.log(`  ${binLabel} dB | ${bar} ${count}${marker}`);
  }
}

/**
 * Main
 */
function main() {
  const directory = process.argv[2] || './temp';

  console.log('='.repeat(80));
  console.log('PROPER NOISE GATE THRESHOLD ANALYSIS');
  console.log('Using 100ms window distribution (not mean levels)');
  console.log('='.repeat(80));
  console.log(`\nCurrent threshold: ${CURRENT_THRESHOLD} dB\n`);

  const files = fs.readdirSync(directory)
    .filter(f => f.endsWith('.mp3'))
    .map(f => path.join(directory, f))
    .sort();

  if (files.length === 0) {
    console.log('No MP3 files found');
    return;
  }

  const results = [];
  for (const file of files) {
    const result = analyzeFile(file);
    if (result) results.push(result);
  }

  // Summary table
  console.log('\n' + '='.repeat(80));
  console.log('DISTRIBUTION ANALYSIS');
  console.log('='.repeat(80));
  console.log('');
  console.log('Track                   | Noise Floor | Signal Level | Gap     | p10    | p90    |');
  console.log('------------------------|-------------|--------------|---------|--------|--------|');

  for (const r of results) {
    const name = r.fileName.replace('.mp3', '').padEnd(23).slice(0, 23);
    const noise = r.noiseFloor?.toFixed(1).padStart(11) || '        N/A';
    const signal = r.signalLevel?.toFixed(1).padStart(12) || '         N/A';
    const gap = r.gap ? `${r.gap.size.toFixed(0)}dB`.padStart(7) : '   none';
    const p10 = r.percentiles?.p10?.toFixed(1).padStart(6) || '   N/A';
    const p90 = r.percentiles?.p90?.toFixed(1).padStart(6) || '   N/A';

    console.log(`${name} | ${noise} | ${signal} | ${gap} | ${p10} | ${p90} |`);
  }

  // Find the track with best separation to show histogram
  const bestTrack = results.find(r => r.gap && r.gap.size > 5) || results[0];
  if (bestTrack && bestTrack.histogram) {
    console.log(`\n\nHistogram for ${bestTrack.fileName}:`);
    printHistogram(bestTrack.histogram, CURRENT_THRESHOLD);
  }

  // Analysis
  console.log('\n' + '='.repeat(80));
  console.log('THRESHOLD ANALYSIS');
  console.log('='.repeat(80));

  const noiseFloors = results.map(r => r.noiseFloor).filter(x => x != null);
  const signalLevels = results.map(r => r.signalLevel).filter(x => x != null);
  const p10s = results.map(r => r.percentiles?.p10).filter(x => x != null);
  const p90s = results.map(r => r.percentiles?.p90).filter(x => x != null);

  const avgNoiseFloor = noiseFloors.reduce((a, b) => a + b, 0) / noiseFloors.length;
  const avgSignalLevel = signalLevels.reduce((a, b) => a + b, 0) / signalLevels.length;
  const worstNoiseFloor = Math.max(...noiseFloors);  // Highest noise floor
  const quietestSignal = Math.min(...p90s);  // Quietest "loud" level

  console.log(`
📊 CLUSTER ANALYSIS:
   Noise floor range: ${Math.min(...noiseFloors).toFixed(1)} to ${Math.max(...noiseFloors).toFixed(1)} dB
   Signal level range: ${Math.min(...signalLevels).toFixed(1)} to ${Math.max(...signalLevels).toFixed(1)} dB

   Average noise floor (bottom 10%): ${avgNoiseFloor.toFixed(1)} dB
   Average signal level (top 25%): ${avgSignalLevel.toFixed(1)} dB
   Dynamic range: ${(avgSignalLevel - avgNoiseFloor).toFixed(1)} dB

📍 KEY LEVELS:
   Worst (highest) noise floor: ${worstNoiseFloor.toFixed(1)} dB
   Quietest p90 (soft playing): ${quietestSignal.toFixed(1)} dB
   Gap between them: ${(quietestSignal - worstNoiseFloor).toFixed(1)} dB

🎯 THRESHOLD PLACEMENT:
   Current threshold: ${CURRENT_THRESHOLD} dB
`);

  // Check where current threshold sits
  if (CURRENT_THRESHOLD > quietestSignal) {
    console.log(`   ❌ PROBLEM: Threshold (${CURRENT_THRESHOLD} dB) is ABOVE the quietest signal (${quietestSignal.toFixed(1)} dB)!`);
    console.log(`      This will gate actual music during soft passages.`);
  } else if (CURRENT_THRESHOLD < worstNoiseFloor) {
    console.log(`   ✓ Threshold is ${(worstNoiseFloor - CURRENT_THRESHOLD).toFixed(1)} dB below noise floor.`);
    console.log(`      This may not gate noise effectively.`);
  } else {
    console.log(`   Threshold sits between noise floor and signal.`);
    const marginToSignal = quietestSignal - CURRENT_THRESHOLD;
    const marginToNoise = CURRENT_THRESHOLD - worstNoiseFloor;
    console.log(`   Margin to signal: ${marginToSignal.toFixed(1)} dB`);
    console.log(`   Margin to noise: ${marginToNoise.toFixed(1)} dB`);
  }

  // Recommendation
  const idealThreshold = worstNoiseFloor + (quietestSignal - worstNoiseFloor) * 0.3;
  const safeThreshold = worstNoiseFloor + 3;  // 3dB above noise floor

  console.log(`
🔧 RECOMMENDATIONS:
   1. Ideal threshold (30% into gap): ${idealThreshold.toFixed(0)} dB
   2. Safe threshold (3dB above noise): ${safeThreshold.toFixed(0)} dB
   3. Conservative (at noise floor): ${Math.ceil(worstNoiseFloor)} dB
`);

  console.log('='.repeat(80));
}

main();
