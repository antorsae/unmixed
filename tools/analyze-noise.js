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

const path = require('path');
const {
  listAudioFiles,
  getAudioInfo,
  getVolumeStats,
  getWindowRmsLevels,
  summarizeLevels,
  averageOfLowest,
} = require('./audio-analysis-utils');

// Configuration
const WINDOW_MS = 100;  // Analysis window size in ms (p90-based distribution)
const DEFAULT_THRESHOLD_DB = -48;

/**
 * Analyze a single audio file
 */
async function analyzeFile(filePath, thresholdDb) {
  const fileName = path.basename(filePath);
  console.log(`\nAnalyzing: ${fileName}`);

  // Get basic stats
  const { duration, sampleRate } = getAudioInfo(filePath);

  // Get overall volume
  const volume = getVolumeStats(filePath);

  // Get per-frame RMS levels
  const rmsLevels = await getWindowRmsLevels(filePath, WINDOW_MS, { sampleRate });

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

  const summary = summarizeLevels(rmsLevels, [0.1, 0.25, 0.5, 0.75, 0.9, 0.95]);
  const sortedRms = summary.sorted;

  // Calculate statistics
  const avgNoiseFloor = averageOfLowest(sortedRms, 0.1);
  const p10 = summary.p10;
  const p25 = summary.p25;
  const median = summary.p50;
  const p75 = summary.p75;
  const p90 = summary.p90;
  const p95 = summary.p95;

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

  // Recommended threshold: 30% into the gap between p10 (noise) and p90 (signal)
  const recommendedThreshold = (Number.isFinite(p10) && Number.isFinite(p90))
    ? Math.round(p10 + (p90 - p10) * 0.3)
    : null;

  return {
    fileName,
    duration: duration.toFixed(1),
    sampleRate,
    meanVolume: volume.meanVolume?.toFixed(1),
    maxVolume: volume.maxVolume?.toFixed(1),
    noiseFloor: p10?.toFixed(1),
    avgNoiseFloor: avgNoiseFloor?.toFixed(1),
    p25: p25?.toFixed(1),
    median: median?.toFixed(1),
    p75: p75?.toFixed(1),
    p90: p90?.toFixed(1),
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
  const files = listAudioFiles(directory);

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
  console.log('Track                   | Mean dB | Max dB | p10   | p90   | % Below Thresh | Longest Silent | Recommended');
  console.log('------------------------|---------|--------|-------|-------|----------------|----------------|------------');

  for (const r of results) {
    const name = r.fileName.replace('.mp3', '').padEnd(23).slice(0, 23);
    const mean = (r.meanVolume || 'N/A').toString().padStart(7);
    const max = (r.maxVolume || 'N/A').toString().padStart(6);
    const p10 = (r.noiseFloor || 'N/A').toString().padStart(5);
    const p90 = (r.p90 || 'N/A').toString().padStart(5);
    const pct = (r.pctBelowThreshold || 'N/A').toString().padStart(14) + '%';
    const silent = (r.longestSilentMs + 'ms').padStart(14);
    const rec = (r.recommendedThreshold !== null ? `${r.recommendedThreshold}dB` : 'N/A').padStart(10);

    console.log(`${name} | ${mean} | ${max} | ${p10} | ${p90} | ${pct} | ${silent} | ${rec}`);
  }

  // Analysis
  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS');
  console.log('='.repeat(80));

  const noiseFloors = results.map(r => parseFloat(r.noiseFloor)).filter(x => !isNaN(x));
  const signals = results.map(r => parseFloat(r.p90)).filter(x => !isNaN(x));
  const overallNoiseFloor = noiseFloors.length
    ? noiseFloors.reduce((a, b) => a + b, 0) / noiseFloors.length
    : NaN;
  const overallSignal = signals.length
    ? signals.reduce((a, b) => a + b, 0) / signals.length
    : NaN;

  const avgPctBelow = results.map(r => parseFloat(r.pctBelowThreshold)).filter(x => !isNaN(x));
  const overallPctBelow = avgPctBelow.length
    ? avgPctBelow.reduce((a, b) => a + b, 0) / avgPctBelow.length
    : NaN;

  const recommendedThresholds = results.map(r => r.recommendedThreshold).filter(x => x != null);
  const maxRecommended = recommendedThresholds.length ? Math.max(...recommendedThresholds) : null;
  const minRecommended = recommendedThresholds.length ? Math.min(...recommendedThresholds) : null;

  console.log(`\nCurrent threshold: ${thresholdDb} dB`);
  console.log(`Average p10 noise floor: ${overallNoiseFloor.toFixed(1)} dB`);
  console.log(`Average p90 signal level: ${overallSignal.toFixed(1)} dB`);
  console.log(`Average % of audio below threshold: ${overallPctBelow.toFixed(1)}%`);
  if (minRecommended !== null && maxRecommended !== null) {
    console.log(`\nPer-track recommended thresholds range: ${minRecommended} dB to ${maxRecommended} dB`);
  }

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

  const worstNoiseFloor = noiseFloors.length ? Math.max(...noiseFloors) : null;
  const quietestSignal = signals.length ? Math.min(...signals) : null;

  if (Number.isFinite(worstNoiseFloor) && Number.isFinite(quietestSignal)) {
    const gap = quietestSignal - worstNoiseFloor;
    const idealThreshold = Math.round(worstNoiseFloor + gap * 0.3);
    const safeThreshold = Math.round(worstNoiseFloor + 3);

    console.log(`\nWorst (highest) noise floor: ${worstNoiseFloor.toFixed(1)} dB`);
    console.log(`Quietest p90 signal: ${quietestSignal.toFixed(1)} dB`);
    console.log(`Gap between them: ${gap.toFixed(1)} dB`);

    if (thresholdDb > quietestSignal) {
      console.log(`\n❌ ISSUE: Threshold (${thresholdDb} dB) is ABOVE the quietest p90 signal (${quietestSignal.toFixed(1)} dB)`);
      console.log('   This means the gate threshold is set too high and will gate actual music.');
    } else if (thresholdDb < worstNoiseFloor) {
      console.log(`\n⚠️  Threshold (${thresholdDb} dB) is BELOW the noise floor (${worstNoiseFloor.toFixed(1)} dB).`);
      console.log('   This may not gate noise effectively.');
    } else {
      const marginToSignal = quietestSignal - thresholdDb;
      const marginToNoise = thresholdDb - worstNoiseFloor;
      console.log(`\n✓ Threshold sits between noise and signal.`);
      console.log(`   Margin to signal: ${marginToSignal.toFixed(1)} dB`);
      console.log(`   Margin to noise: ${marginToNoise.toFixed(1)} dB`);
    }

    console.log(`\nIdeal threshold (30% into gap): ${idealThreshold} dB`);
    console.log(`Safe threshold (3dB above noise): ${safeThreshold} dB`);
  }

  // Final recommendation
  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDATION');
  console.log('='.repeat(80));

  if (Number.isFinite(worstNoiseFloor)) {
    const conservative = Math.round(worstNoiseFloor);
    console.log(`\nConservative threshold (at noise floor): ${conservative} dB`);
  }
}

main().catch(console.error);
