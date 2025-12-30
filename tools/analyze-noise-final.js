#!/usr/bin/env node
/**
 * Final Audio Analysis Tool
 * Uses ffmpeg's built-in noise floor detection (astats filter)
 *
 * Key metrics:
 * - Noise floor dB: Level during silent portions (what the gate should suppress)
 * - RMS level dB: Average level during playing
 * - RMS peak dB: Peak RMS level
 * - Peak level dB: Absolute peak
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CURRENT_THRESHOLD = -48;

function analyzeFile(filePath) {
  const fileName = path.basename(filePath);

  const result = execSync(
    `ffmpeg -i "${filePath}" -af "astats" -f null - 2>&1`,
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );

  // Parse the Overall section
  const noiseFloorMatch = result.match(/Noise floor dB:\s*([-\d.]+)/);
  const rmsLevelMatch = result.match(/RMS level dB:\s*([-\d.]+)/);
  const rmsPeakMatch = result.match(/RMS peak dB:\s*([-\d.]+)/);
  const rmsTroughMatch = result.match(/RMS trough dB:\s*([-\d.]+)/);
  const peakLevelMatch = result.match(/Peak level dB:\s*([-\d.]+)/);

  return {
    fileName,
    noiseFloor: noiseFloorMatch ? parseFloat(noiseFloorMatch[1]) : null,
    rmsLevel: rmsLevelMatch ? parseFloat(rmsLevelMatch[1]) : null,
    rmsPeak: rmsPeakMatch ? parseFloat(rmsPeakMatch[1]) : null,
    rmsTrough: rmsTroughMatch ? parseFloat(rmsTroughMatch[1]) : null,
    peakLevel: peakLevelMatch ? parseFloat(peakLevelMatch[1]) : null,
  };
}

function main() {
  const directory = process.argv[2] || './temp';

  console.log('='.repeat(90));
  console.log('NOISE GATE THRESHOLD ANALYSIS (using ffmpeg noise floor detection)');
  console.log('='.repeat(90));
  console.log(`\nCurrent noise gate threshold: ${CURRENT_THRESHOLD} dB\n`);

  const files = fs.readdirSync(directory)
    .filter(f => f.endsWith('.mp3'))
    .map(f => path.join(directory, f))
    .sort();

  const results = [];
  for (const file of files) {
    process.stdout.write(`Analyzing ${path.basename(file)}... `);
    const r = analyzeFile(file);
    results.push(r);
    console.log('done');
  }

  // Table
  console.log('\n' + '='.repeat(90));
  console.log('RESULTS');
  console.log('='.repeat(90));
  console.log('');
  console.log('Track                   | Noise Floor | RMS Peak | Peak    | Dynamic Range | Gate Status');
  console.log('------------------------|-------------|----------|---------|---------------|-------------');

  for (const r of results) {
    const name = r.fileName.replace('.mp3', '').padEnd(23).slice(0, 23);
    const noise = r.noiseFloor?.toFixed(1).padStart(11) || '        N/A';
    const rmsPeak = r.rmsPeak?.toFixed(1).padStart(8) || '     N/A';
    const peak = r.peakLevel?.toFixed(1).padStart(7) || '    N/A';

    // Dynamic range = peak RMS - noise floor (how much headroom for gating)
    const dynamicRange = (r.rmsPeak && r.noiseFloor)
      ? (r.rmsPeak - r.noiseFloor).toFixed(0) + ' dB'
      : 'N/A';

    // Gate status: is the threshold between noise and signal?
    let status = '';
    if (r.noiseFloor && r.rmsPeak) {
      if (CURRENT_THRESHOLD < r.noiseFloor) {
        status = '⚠️ Below noise';
      } else if (CURRENT_THRESHOLD > r.rmsPeak) {
        status = '❌ GATES MUSIC';
      } else {
        const marginToSignal = r.rmsPeak - CURRENT_THRESHOLD;
        status = `✓ OK (${marginToSignal.toFixed(0)}dB margin)`;
      }
    }

    console.log(`${name} | ${noise} | ${rmsPeak} | ${peak} | ${dynamicRange.padStart(13)} | ${status}`);
  }

  // Analysis
  console.log('\n' + '='.repeat(90));
  console.log('ANALYSIS');
  console.log('='.repeat(90));

  const noiseFloors = results.map(r => r.noiseFloor).filter(x => x != null);
  const rmsPeaks = results.map(r => r.rmsPeak).filter(x => x != null);

  const avgNoiseFloor = noiseFloors.reduce((a, b) => a + b, 0) / noiseFloors.length;
  const highestNoiseFloor = Math.max(...noiseFloors);
  const lowestRmsPeak = Math.min(...rmsPeaks);

  const gapSize = lowestRmsPeak - highestNoiseFloor;

  console.log(`
📊 KEY FINDINGS:

   NOISE FLOOR (level during rests):
   - Average: ${avgNoiseFloor.toFixed(1)} dB
   - Highest (worst): ${highestNoiseFloor.toFixed(1)} dB (${results.find(r => r.noiseFloor === highestNoiseFloor)?.fileName})

   SIGNAL LEVEL (RMS peak during playing):
   - Lowest: ${lowestRmsPeak.toFixed(1)} dB (${results.find(r => r.rmsPeak === lowestRmsPeak)?.fileName})

   GAP (where threshold should go):
   - Size: ${gapSize.toFixed(1)} dB (from ${highestNoiseFloor.toFixed(1)} to ${lowestRmsPeak.toFixed(1)})

🎯 THRESHOLD EVALUATION:
   Current threshold: ${CURRENT_THRESHOLD} dB
`);

  if (CURRENT_THRESHOLD > lowestRmsPeak) {
    console.log(`   ❌ PROBLEM: Threshold (${CURRENT_THRESHOLD} dB) is ABOVE the quietest signal (${lowestRmsPeak.toFixed(1)} dB)!`);
    console.log(`      The gate will cut into actual music during soft passages.`);
    console.log(`      ${results.filter(r => r.rmsPeak && CURRENT_THRESHOLD > r.rmsPeak).length} tracks affected.`);
  } else if (CURRENT_THRESHOLD < highestNoiseFloor) {
    console.log(`   ⚠️ Threshold (${CURRENT_THRESHOLD} dB) is BELOW the noise floor (${highestNoiseFloor.toFixed(1)} dB).`);
    console.log(`      The gate may not be effective at removing noise.`);
  } else {
    const marginToSignal = lowestRmsPeak - CURRENT_THRESHOLD;
    const marginToNoise = CURRENT_THRESHOLD - highestNoiseFloor;
    console.log(`   ✓ Threshold is properly positioned between noise and signal.`);
    console.log(`      Margin above noise: ${marginToNoise.toFixed(1)} dB`);
    console.log(`      Margin below signal: ${marginToSignal.toFixed(1)} dB`);
  }

  // Recommendations
  const idealThreshold = highestNoiseFloor + (gapSize * 0.25);  // 25% into the gap
  const safeThreshold = highestNoiseFloor + 6;  // 6dB above noise

  console.log(`
🔧 RECOMMENDATIONS:

   For these Aalto recordings:
   1. Optimal threshold: ${idealThreshold.toFixed(0)} dB (25% above noise floor)
   2. Safe threshold: ${safeThreshold.toFixed(0)} dB (6dB above noise floor)
   3. Noise floor level: ${Math.ceil(highestNoiseFloor)} dB (matches noise exactly)

   Current default (${CURRENT_THRESHOLD} dB) is ${(CURRENT_THRESHOLD - idealThreshold).toFixed(0)} dB too high.
`);

  // Per-track issues
  const problematicTracks = results.filter(r => r.rmsPeak && CURRENT_THRESHOLD > r.rmsPeak);
  if (problematicTracks.length > 0) {
    console.log('⚠️  TRACKS WHERE CURRENT THRESHOLD GATES MUSIC:');
    for (const t of problematicTracks) {
      console.log(`   - ${t.fileName}: RMS peak ${t.rmsPeak.toFixed(1)} dB < threshold ${CURRENT_THRESHOLD} dB`);
    }
  }

  console.log('\n' + '='.repeat(90));
  console.log(`SUGGESTED NEW DEFAULT: ${idealThreshold.toFixed(0)} dB`);
  console.log('='.repeat(90));
}

main();
