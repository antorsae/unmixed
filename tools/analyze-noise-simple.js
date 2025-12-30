#!/usr/bin/env node
/**
 * Simple Audio Level Analyzer
 * Shows why -48dB noise gate is too aggressive for Aalto recordings
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const THRESHOLD_DB = -48;

function analyzeFile(filePath) {
  const fileName = path.basename(filePath);

  // Get volume stats
  const result = execSync(
    `ffmpeg -i "${filePath}" -af "volumedetect" -f null - 2>&1`,
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );

  const meanMatch = result.match(/mean_volume:\s*([-\d.]+)\s*dB/);
  const maxMatch = result.match(/max_volume:\s*([-\d.]+)\s*dB/);
  const histMatch = result.match(/histogram_(\d+)db:\s*(\d+)/g);

  const meanDb = meanMatch ? parseFloat(meanMatch[1]) : null;
  const maxDb = maxMatch ? parseFloat(maxMatch[1]) : null;

  // Parse histogram for distribution
  const histogram = {};
  if (histMatch) {
    for (const h of histMatch) {
      const m = h.match(/histogram_(\d+)db:\s*(\d+)/);
      if (m) {
        histogram[parseInt(m[1])] = parseInt(m[2]);
      }
    }
  }

  // Calculate what % is below threshold
  let totalSamples = 0;
  let belowThreshold = 0;
  for (const [db, count] of Object.entries(histogram)) {
    totalSamples += count;
    if (-parseInt(db) < THRESHOLD_DB) {
      belowThreshold += count;
    }
  }
  const pctBelow = totalSamples > 0 ? (belowThreshold / totalSamples * 100) : null;

  return { fileName, meanDb, maxDb, pctBelow, histogram };
}

function main() {
  const directory = process.argv[2] || './temp';

  console.log('='.repeat(80));
  console.log('AALTO RECORDINGS NOISE GATE ANALYSIS');
  console.log('='.repeat(80));
  console.log(`\nCurrent noise gate threshold: ${THRESHOLD_DB} dB`);
  console.log('');

  const files = fs.readdirSync(directory)
    .filter(f => f.endsWith('.mp3'))
    .map(f => path.join(directory, f))
    .sort();

  console.log('Track                   | Mean dB | Peak dB | Problem');
  console.log('------------------------|---------|---------|------------------------------------------');

  const results = [];
  for (const file of files) {
    const r = analyzeFile(file);
    results.push(r);

    const name = r.fileName.replace('.mp3', '').padEnd(23).slice(0, 23);
    const mean = r.meanDb?.toFixed(1).padStart(7) || '   N/A';
    const max = r.maxDb?.toFixed(1).padStart(7) || '   N/A';

    let problem = '';
    if (r.meanDb && r.meanDb < THRESHOLD_DB) {
      problem = `⚠️  MEAN is ${(THRESHOLD_DB - r.meanDb).toFixed(0)}dB below threshold!`;
    } else if (r.meanDb) {
      const margin = r.meanDb - THRESHOLD_DB;
      problem = margin < 6 ? `Thin margin (${margin.toFixed(0)}dB)` : '✓ OK';
    }

    console.log(`${name} | ${mean} | ${max} | ${problem}`);
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('ROOT CAUSE ANALYSIS');
  console.log('='.repeat(80));

  const meanLevels = results.map(r => r.meanDb).filter(x => x != null);
  const avgMean = meanLevels.reduce((a, b) => a + b, 0) / meanLevels.length;
  const quietestMean = Math.min(...meanLevels);
  const loudestMean = Math.max(...meanLevels);

  console.log(`
📊 RECORDING LEVELS:
   - Average mean level: ${avgMean.toFixed(1)} dB
   - Quietest track: ${quietestMean.toFixed(1)} dB (${results.find(r => r.meanDb === quietestMean)?.fileName})
   - Loudest track: ${loudestMean.toFixed(1)} dB (${results.find(r => r.meanDb === loudestMean)?.fileName})

🚨 THE PROBLEM:
   The noise gate threshold is ${THRESHOLD_DB} dB, but the AVERAGE signal level
   across these Aalto recordings is ${avgMean.toFixed(1)} dB!

   This means the gate is cutting into ACTUAL MUSIC, not just noise.

   The quietest track (${results.find(r => r.meanDb === quietestMean)?.fileName})
   has a mean level of ${quietestMean.toFixed(1)} dB - that's ${(THRESHOLD_DB - quietestMean).toFixed(0)} dB BELOW the gate threshold!

💡 WHY THIS HAPPENS:
   Aalto anechoic recordings use UNIFORM GAIN across all instruments to preserve
   the natural loudness relationships of an orchestra. Quiet instruments like
   violins and flutes are recorded at their natural (quiet) levels.

   A typical pop/rock recording would normalize each track to ~-18 dB RMS.
   These orchestral recordings are at their natural levels: -45 to -65 dB.

🔧 RECOMMENDATIONS:
   1. BEST: Lower threshold to ${Math.floor(quietestMean - 12)} dB or lower
   2. GOOD: Lower threshold to ${Math.floor(avgMean - 6)} dB (6dB below average)
   3. SAFE: Disable noise gate entirely for Aalto recordings

   The Aalto recordings were made in an anechoic chamber - there's very little
   noise to gate anyway! The main noise is from the recording equipment itself.
`);

  // Suggest specific threshold
  const suggestedThreshold = Math.floor(quietestMean - 12);
  console.log('='.repeat(80));
  console.log(`SUGGESTED DEFAULT: ${suggestedThreshold} dB`);
  console.log('='.repeat(80));
}

main();
