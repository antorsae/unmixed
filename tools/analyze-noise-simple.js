#!/usr/bin/env node
/**
 * Simple Noise Gate Analyzer
 * Quick p10/p90 windowed RMS summary for a directory of audio files.
 */

const path = require('path');
const {
  listAudioFiles,
  getWindowRmsLevels,
  summarizeLevels,
} = require('./audio-analysis-utils');

const WINDOW_MS = 100;
const DEFAULT_THRESHOLD_DB = -74;
const RECOMMEND_FRACTION = 0.3;

function recommendThreshold(p10, p90) {
  if (!Number.isFinite(p10) || !Number.isFinite(p90)) return null;
  return Math.round(p10 + (p90 - p10) * RECOMMEND_FRACTION);
}

async function analyzeFile(filePath, thresholdDb) {
  const fileName = path.basename(filePath);
  const levels = await getWindowRmsLevels(filePath, WINDOW_MS, {
    discardBelowMin: true,
    fallbackToPeak: true,
    minLevels: 10,
  });

  if (!levels.length) {
    return { fileName, error: 'no_rms' };
  }

  const summary = summarizeLevels(levels, [0.1, 0.9]);
  const p10 = summary.p10;
  const p90 = summary.p90;
  const recommended = recommendThreshold(p10, p90);
  const below = levels.filter(level => level < thresholdDb).length;
  const pctBelow = levels.length ? (below / levels.length) * 100 : 0;

  return {
    fileName,
    p10,
    p90,
    recommended,
    pctBelow,
    windows: levels.length,
  };
}

function parseArgs(args) {
  let directory = './temp';
  let thresholdDb = DEFAULT_THRESHOLD_DB;

  for (const arg of args) {
    if (arg.startsWith('--threshold=')) {
      thresholdDb = parseFloat(arg.split('=')[1]);
    } else if (!arg.startsWith('-')) {
      directory = arg;
    }
  }

  return { directory, thresholdDb };
}

async function main() {
  const { directory, thresholdDb } = parseArgs(process.argv.slice(2));
  const files = listAudioFiles(directory);

  console.log('='.repeat(80));
  console.log('SIMPLE NOISE GATE ANALYSIS');
  console.log('='.repeat(80));
  console.log(`Directory: ${directory}`);
  console.log(`Threshold: ${thresholdDb} dB`);
  console.log(`Window: ${WINDOW_MS} ms\n`);

  if (!files.length) {
    console.log('No audio files found.');
    return;
  }

  const results = [];
  for (const file of files) {
    const result = await analyzeFile(file, thresholdDb);
    results.push(result);
  }

  console.log('Track                   | p10   | p90   | % < Thresh | Recommended');
  console.log('------------------------|-------|-------|------------|------------');

  for (const r of results) {
    const name = r.fileName.replace(path.extname(r.fileName), '').padEnd(23).slice(0, 23);
    if (r.error) {
      console.log(`${name} |  N/A |  N/A |        N/A |        N/A`);
      continue;
    }
    const p10 = r.p10?.toFixed(1).padStart(5) ?? ' N/A';
    const p90 = r.p90?.toFixed(1).padStart(5) ?? ' N/A';
    const pct = r.pctBelow.toFixed(1).padStart(10) + '%';
    const rec = (r.recommended !== null ? `${r.recommended}dB` : 'N/A').padStart(10);
    console.log(`${name} | ${p10} | ${p90} | ${pct} | ${rec}`);
  }

  const valid = results.filter(r => !r.error);
  if (!valid.length) return;

  const p10s = valid.map(r => r.p10).filter(Number.isFinite);
  const p90s = valid.map(r => r.p90).filter(Number.isFinite);
  const quietestP90 = Math.min(...p90s);
  const highestP10 = Math.max(...p10s);

  console.log('\nSummary:');
  console.log(`- p10 range: ${Math.min(...p10s).toFixed(1)} to ${Math.max(...p10s).toFixed(1)} dB`);
  console.log(`- p90 range: ${Math.min(...p90s).toFixed(1)} to ${Math.max(...p90s).toFixed(1)} dB`);
  console.log(`- Quietest p90: ${quietestP90.toFixed(1)} dB`);
  console.log(`- Loudest p10: ${highestP10.toFixed(1)} dB`);
}

main();
