#!/usr/bin/env node
/**
 * Audio Noise Level Analyzer
 *
 * Analyzes MP3 files to determine:
 * - Overall RMS level
 * - Noise floor (quietest 10% of windows)
 * - Peak levels
 * - What percentage of audio falls below the noise gate threshold
 * - Recommended noise gate threshold
 *
 * Usage: node tools/analyze-noise.js [directory] [--threshold=-48]
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const WINDOW_MS = 20;  // RMS window size in ms (matches noise gate windowMs)
const DEFAULT_THRESHOLD_DB = -48;

/**
 * Get audio stats using ffmpeg astats filter
 */
function getAudioStats(filePath) {
  try {
    const result = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(result);
  } catch (e) {
    console.error(`Error getting stats for ${filePath}:`, e.message);
    return null;
  }
}

/**
 * Analyze RMS levels using ffmpeg volumedetect and ebur128
 */
function analyzeVolume(filePath) {
  try {
    // Get overall volume stats
    const volumeResult = execSync(
      `ffmpeg -i "${filePath}" -af "volumedetect" -f null - 2>&1`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );

    const meanMatch = volumeResult.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    const maxMatch = volumeResult.match(/max_volume:\s*([-\d.]+)\s*dB/);

    return {
      meanVolume: meanMatch ? parseFloat(meanMatch[1]) : null,
      maxVolume: maxMatch ? parseFloat(maxMatch[1]) : null,
    };
  } catch (e) {
    console.error(`Error analyzing volume for ${filePath}:`, e.message);
    return { meanVolume: null, maxVolume: null };
  }
}

/**
 * Get per-frame RMS levels using ffmpeg astats
 */
function getFrameRmsLevels(filePath, windowMs = WINDOW_MS) {
  return new Promise((resolve, reject) => {
    const rmsLevels = [];

    // Use astats with reset to get per-window RMS
    // metadata=1 prints stats, reset=1 resets after each window
    const sampleRate = 44100;  // Assume 44.1kHz, adjust if needed
    const windowSamples = Math.floor(sampleRate * windowMs / 1000);

    const ffmpeg = spawn('ffmpeg', [
      '-i', filePath,
      '-af', `astats=metadata=1:reset=${windowSamples}`,
      '-f', 'null',
      '-'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      // Parse RMS levels from astats output
      // Format: [Parsed_astats_0 @ ...] RMS level dB: -XX.XX
      const rmsMatches = stderr.matchAll(/RMS level dB:\s*([-\d.]+|inf|-inf)/g);
      for (const match of rmsMatches) {
        const level = match[1] === '-inf' ? -100 :
                      match[1] === 'inf' ? 0 :
                      parseFloat(match[1]);
        if (!isNaN(level)) {
          rmsLevels.push(level);
        }
      }
      resolve(rmsLevels);
    });

    ffmpeg.on('error', reject);
  });
}

/**
 * Analyze a single audio file
 */
async function analyzeFile(filePath, thresholdDb) {
  const fileName = path.basename(filePath);
  console.log(`\nAnalyzing: ${fileName}`);

  // Get basic stats
  const stats = getAudioStats(filePath);
  if (!stats) return null;

  const duration = parseFloat(stats.format?.duration || 0);
  const sampleRate = parseInt(stats.streams?.[0]?.sample_rate || 44100);

  // Get overall volume
  const volume = analyzeVolume(filePath);

  // Get per-frame RMS levels
  const rmsLevels = await getFrameRmsLevels(filePath);

  if (rmsLevels.length === 0) {
    console.log(`  Warning: Could not extract RMS levels`);
    return {
      fileName,
      duration,
      sampleRate,
      ...volume,
      error: 'No RMS data'
    };
  }

  // Sort for percentile analysis
  const sortedRms = [...rmsLevels].sort((a, b) => a - b);

  // Calculate statistics
  const noiseFloor = sortedRms[Math.floor(sortedRms.length * 0.05)];  // 5th percentile
  const quietestWindows = sortedRms.slice(0, Math.floor(sortedRms.length * 0.1));
  const avgNoiseFloor = quietestWindows.reduce((a, b) => a + b, 0) / quietestWindows.length;

  const median = sortedRms[Math.floor(sortedRms.length * 0.5)];
  const p25 = sortedRms[Math.floor(sortedRms.length * 0.25)];
  const p75 = sortedRms[Math.floor(sortedRms.length * 0.75)];
  const p95 = sortedRms[Math.floor(sortedRms.length * 0.95)];

  // Count windows below threshold
  const belowThreshold = rmsLevels.filter(l => l < thresholdDb).length;
  const pctBelowThreshold = (belowThreshold / rmsLevels.length * 100).toFixed(1);

  // Find contiguous silent regions (potential false-gating during quiet passages)
  let longestSilentRun = 0;
  let currentRun = 0;
  for (const level of rmsLevels) {
    if (level < thresholdDb) {
      currentRun++;
      longestSilentRun = Math.max(longestSilentRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  const longestSilentMs = longestSilentRun * WINDOW_MS;

  // Recommend threshold: 6dB below the 10th percentile quietest signal
  const p10 = sortedRms[Math.floor(sortedRms.length * 0.1)];
  const recommendedThreshold = Math.floor(p10 - 6);

  return {
    fileName,
    duration: duration.toFixed(1),
    sampleRate,
    meanVolume: volume.meanVolume?.toFixed(1),
    maxVolume: volume.maxVolume?.toFixed(1),
    noiseFloor: noiseFloor?.toFixed(1),
    avgNoiseFloor: avgNoiseFloor?.toFixed(1),
    p25: p25?.toFixed(1),
    median: median?.toFixed(1),
    p75: p75?.toFixed(1),
    p95: p95?.toFixed(1),
    pctBelowThreshold,
    longestSilentMs,
    recommendedThreshold,
    totalWindows: rmsLevels.length,
  };
}

/**
 * Main analysis function
 */
async function main() {
  const args = process.argv.slice(2);
  let directory = './temp';
  let thresholdDb = DEFAULT_THRESHOLD_DB;

  for (const arg of args) {
    if (arg.startsWith('--threshold=')) {
      thresholdDb = parseFloat(arg.split('=')[1]);
    } else if (!arg.startsWith('-')) {
      directory = arg;
    }
  }

  console.log('='.repeat(80));
  console.log('AUDIO NOISE LEVEL ANALYZER');
  console.log('='.repeat(80));
  console.log(`Directory: ${directory}`);
  console.log(`Noise Gate Threshold: ${thresholdDb} dB`);
  console.log(`Analysis Window: ${WINDOW_MS} ms`);
  console.log('='.repeat(80));

  // Find all MP3 files
  const files = fs.readdirSync(directory)
    .filter(f => f.endsWith('.mp3'))
    .map(f => path.join(directory, f))
    .sort();

  if (files.length === 0) {
    console.log('No MP3 files found in', directory);
    return;
  }

  console.log(`Found ${files.length} MP3 files\n`);

  const results = [];

  for (const file of files) {
    const result = await analyzeFile(file, thresholdDb);
    if (result) {
      results.push(result);
    }
  }

  // Print summary table
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY TABLE');
  console.log('='.repeat(80));
  console.log('');
  console.log('Track                   | Mean dB | Max dB | Noise Floor | % Below Thresh | Longest Silent | Recommended');
  console.log('------------------------|---------|--------|-------------|----------------|----------------|------------');

  for (const r of results) {
    const name = r.fileName.replace('.mp3', '').padEnd(23).slice(0, 23);
    const mean = (r.meanVolume || 'N/A').toString().padStart(7);
    const max = (r.maxVolume || 'N/A').toString().padStart(6);
    const floor = (r.avgNoiseFloor || 'N/A').toString().padStart(11);
    const pct = (r.pctBelowThreshold || 'N/A').toString().padStart(14) + '%';
    const silent = (r.longestSilentMs + 'ms').padStart(14);
    const rec = (r.recommendedThreshold + 'dB').padStart(10);

    console.log(`${name} | ${mean} | ${max} | ${floor} | ${pct} | ${silent} | ${rec}`);
  }

  // Analysis
  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS');
  console.log('='.repeat(80));

  const avgNoiseFloors = results.map(r => parseFloat(r.avgNoiseFloor)).filter(x => !isNaN(x));
  const overallNoiseFloor = avgNoiseFloors.reduce((a, b) => a + b, 0) / avgNoiseFloors.length;

  const avgPctBelow = results.map(r => parseFloat(r.pctBelowThreshold)).filter(x => !isNaN(x));
  const overallPctBelow = avgPctBelow.reduce((a, b) => a + b, 0) / avgPctBelow.length;

  const recommendedThresholds = results.map(r => r.recommendedThreshold).filter(x => x != null);
  const maxRecommended = Math.max(...recommendedThresholds);
  const minRecommended = Math.min(...recommendedThresholds);

  console.log(`\nCurrent threshold: ${thresholdDb} dB`);
  console.log(`Average noise floor across tracks: ${overallNoiseFloor.toFixed(1)} dB`);
  console.log(`Average % of audio below threshold: ${overallPctBelow.toFixed(1)}%`);
  console.log(`\nPer-track recommended thresholds range: ${minRecommended} dB to ${maxRecommended} dB`);

  // Check for problematic tracks
  const problematicTracks = results.filter(r => parseFloat(r.pctBelowThreshold) > 30);

  if (problematicTracks.length > 0) {
    console.log('\n⚠️  PROBLEM: The following tracks have >30% audio below threshold:');
    for (const t of problematicTracks) {
      console.log(`   - ${t.fileName}: ${t.pctBelowThreshold}% gated, noise floor at ${t.avgNoiseFloor} dB`);
    }
  }

  // Root cause analysis
  console.log('\n' + '-'.repeat(80));
  console.log('ROOT CAUSE ANALYSIS');
  console.log('-'.repeat(80));

  if (overallNoiseFloor > thresholdDb) {
    console.log(`\n❌ ISSUE: Average noise floor (${overallNoiseFloor.toFixed(1)} dB) is ABOVE threshold (${thresholdDb} dB)`);
    console.log('   This means the gate threshold is set too high - it will gate actual signal, not just noise.');
    console.log(`   RECOMMENDATION: Lower threshold to at least ${Math.floor(overallNoiseFloor - 6)} dB`);
  } else {
    const margin = thresholdDb - overallNoiseFloor;
    console.log(`\n✓ Noise floor (${overallNoiseFloor.toFixed(1)} dB) is ${margin.toFixed(1)} dB below threshold (${thresholdDb} dB)`);

    if (margin < 6) {
      console.log('   ⚠️  WARNING: Margin is thin - quiet passages may be incorrectly gated');
    }
  }

  // Check quiet instruments
  const quietTracks = results.filter(r => parseFloat(r.meanVolume) < -30);
  if (quietTracks.length > 0) {
    console.log('\n📉 QUIET INSTRUMENTS (mean < -30 dB):');
    for (const t of quietTracks) {
      console.log(`   - ${t.fileName}: mean ${t.meanVolume} dB, noise floor ${t.avgNoiseFloor} dB`);
    }
    console.log('   These quiet instruments are most likely to be incorrectly gated.');
  }

  // Final recommendation
  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDATION');
  console.log('='.repeat(80));

  const safeThreshold = Math.floor(Math.min(...avgNoiseFloors) - 6);
  console.log(`\nSafe threshold for ALL tracks: ${safeThreshold} dB`);
  console.log(`(This is 6 dB below the quietest track's noise floor)`);

  if (safeThreshold > -60) {
    console.log(`\n💡 If ${safeThreshold} dB still gates too aggressively, the actual signal`);
    console.log('   in quiet passages may be at or below the recording noise floor.');
    console.log('   Consider disabling noise gate for these recordings.');
  }
}

main().catch(console.error);
