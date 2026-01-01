#!/usr/bin/env node
/**
 * Final Audio Analysis Tool
 * Uses windowed RMS distribution (p10/p90) for consistent gating guidance.
 */

const path = require('path');
const {
  listAudioFiles,
  getWindowRmsLevels,
  summarizeLevels,
} = require('./audio-analysis-utils');

const CURRENT_THRESHOLD = -48;
const WINDOW_MS = 100;

async function analyzeFile(filePath) {
  const fileName = path.basename(filePath);
  const levels = await getWindowRmsLevels(filePath, WINDOW_MS, {
    discardBelowMin: true,
    fallbackToPeak: true,
    minLevels: 10,
  });

  if (!levels.length) {
    return { fileName, p10: null, p90: null, dynamicRange: null };
  }

  const summary = summarizeLevels(levels, [0.1, 0.9]);
  const p10 = summary.p10;
  const p90 = summary.p90;
  const dynamicRange = (Number.isFinite(p10) && Number.isFinite(p90)) ? (p90 - p10) : null;

  return { fileName, p10, p90, dynamicRange };
}

async function main() {
  const directory = process.argv[2] || './temp';

  console.log('='.repeat(90));
  console.log('NOISE GATE THRESHOLD ANALYSIS (windowed p10/p90)');
  console.log('='.repeat(90));
  console.log(`\nCurrent noise gate threshold: ${CURRENT_THRESHOLD} dB\n`);
  console.log(`Window size: ${WINDOW_MS} ms\n`);

  const files = listAudioFiles(directory);

  const results = [];
  for (const file of files) {
    process.stdout.write(`Analyzing ${path.basename(file)}... `);
    const r = await analyzeFile(file);
    results.push(r);
    console.log('done');
  }

  // Table
  console.log('\n' + '='.repeat(90));
  console.log('RESULTS');
  console.log('='.repeat(90));
  console.log('');
  console.log('Track                   | p10 (Noise) | p90 (Signal) | Range | Gate Status');
  console.log('------------------------|-------------|--------------|-------|-------------');

  for (const r of results) {
    const name = r.fileName.replace('.mp3', '').padEnd(23).slice(0, 23);
    const noise = Number.isFinite(r.p10) ? r.p10.toFixed(1).padStart(11) : '        N/A';
    const signal = Number.isFinite(r.p90) ? r.p90.toFixed(1).padStart(12) : '         N/A';
    const range = Number.isFinite(r.dynamicRange) ? `${r.dynamicRange.toFixed(0)} dB`.padStart(5) : '  N/A';

    // Gate status: is the threshold between noise and signal?
    let status = '';
    if (Number.isFinite(r.p10) && Number.isFinite(r.p90)) {
      if (CURRENT_THRESHOLD < r.p10) {
        status = '⚠️ Below noise';
      } else if (CURRENT_THRESHOLD > r.p90) {
        status = '❌ GATES MUSIC';
      } else {
        const marginToSignal = r.p90 - CURRENT_THRESHOLD;
        status = `✓ OK (${marginToSignal.toFixed(0)}dB margin)`;
      }
    }

    console.log(`${name} | ${noise} | ${signal} | ${range} | ${status}`);
  }

  // Analysis
  console.log('\n' + '='.repeat(90));
  console.log('ANALYSIS');
  console.log('='.repeat(90));

  const noiseFloors = results.map(r => r.p10).filter(x => Number.isFinite(x));
  const signals = results.map(r => r.p90).filter(x => Number.isFinite(x));

  const avgNoiseFloor = noiseFloors.length
    ? noiseFloors.reduce((a, b) => a + b, 0) / noiseFloors.length
    : NaN;
  const highestNoiseFloor = noiseFloors.length ? Math.max(...noiseFloors) : NaN;
  const lowestSignal = signals.length ? Math.min(...signals) : NaN;

  const gapSize = lowestSignal - highestNoiseFloor;

  console.log(`
📊 KEY FINDINGS:

   NOISE FLOOR (p10 window):
   - Average: ${avgNoiseFloor.toFixed(1)} dB
   - Highest (worst): ${highestNoiseFloor.toFixed(1)} dB (${results.find(r => r.p10 === highestNoiseFloor)?.fileName})

   SIGNAL LEVEL (p90 window):
   - Lowest: ${lowestSignal.toFixed(1)} dB (${results.find(r => r.p90 === lowestSignal)?.fileName})

   GAP (where threshold should go):
   - Size: ${gapSize.toFixed(1)} dB (from ${highestNoiseFloor.toFixed(1)} to ${lowestSignal.toFixed(1)})

🎯 THRESHOLD EVALUATION:
   Current threshold: ${CURRENT_THRESHOLD} dB
`);

  if (CURRENT_THRESHOLD > lowestSignal) {
    console.log(`   ❌ PROBLEM: Threshold (${CURRENT_THRESHOLD} dB) is ABOVE the quietest signal (${lowestSignal.toFixed(1)} dB)!`);
    console.log(`      The gate will cut into actual music during soft passages.`);
    console.log(`      ${results.filter(r => Number.isFinite(r.p90) && CURRENT_THRESHOLD > r.p90).length} tracks affected.`);
  } else if (CURRENT_THRESHOLD < highestNoiseFloor) {
    console.log(`   ⚠️ Threshold (${CURRENT_THRESHOLD} dB) is BELOW the noise floor (${highestNoiseFloor.toFixed(1)} dB).`);
    console.log(`      The gate may not be effective at removing noise.`);
  } else {
    const marginToSignal = lowestSignal - CURRENT_THRESHOLD;
    const marginToNoise = CURRENT_THRESHOLD - highestNoiseFloor;
    console.log(`   ✓ Threshold is properly positioned between noise and signal.`);
    console.log(`      Margin above noise: ${marginToNoise.toFixed(1)} dB`);
    console.log(`      Margin below signal: ${marginToSignal.toFixed(1)} dB`);
  }

  // Recommendations
  const idealThreshold = highestNoiseFloor + (gapSize * 0.3);  // 30% into the gap
  const safeThreshold = highestNoiseFloor + 3;  // 3dB above noise

  console.log(`
🔧 RECOMMENDATIONS:

   1. Ideal threshold (30% into gap): ${idealThreshold.toFixed(0)} dB
   2. Safe threshold (3dB above noise): ${safeThreshold.toFixed(0)} dB
   3. Conservative (at noise floor): ${Math.ceil(highestNoiseFloor)} dB

   Current default (${CURRENT_THRESHOLD} dB) is ${(CURRENT_THRESHOLD - idealThreshold).toFixed(0)} dB too high.
`);

  // Per-track issues
  const problematicTracks = results.filter(r => Number.isFinite(r.p90) && CURRENT_THRESHOLD > r.p90);
  if (problematicTracks.length > 0) {
    console.log('⚠️  TRACKS WHERE CURRENT THRESHOLD GATES MUSIC:');
    for (const t of problematicTracks) {
      console.log(`   - ${t.fileName}: p90 ${t.p90.toFixed(1)} dB < threshold ${CURRENT_THRESHOLD} dB`);
    }
  }

  console.log('\n' + '='.repeat(90));
  console.log(`SUGGESTED NEW DEFAULT: ${idealThreshold.toFixed(0)} dB`);
  console.log('='.repeat(90));
}

main().catch(console.error);
