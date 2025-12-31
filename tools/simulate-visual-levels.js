#!/usr/bin/env node
/**
 * Simulate StageCanvas pulse/glow levels based on current visual gating logic.
 *
 * Uses ffmpeg astats per-window RMS to approximate the analyzer input.
 * Reports how often windows would trigger pulse/glow overall and in the first second.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WINDOW_MS = 50;
const START_SECONDS = 1.0;
const NOISE_PERCENTILE = 0.1;
const VISUAL_NOISE_MARGIN_DB = 12;
const VISUAL_DYNAMIC_RANGE_DB = 40;
const MIN_DB = -120;

function getSampleRate(filePath) {
  const probe = execSync(
    `ffprobe -v quiet -print_format json -show_streams "${filePath}"`,
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  const data = JSON.parse(probe);
  const sr = parseInt(data.streams?.[0]?.sample_rate || '44100', 10);
  return Number.isFinite(sr) ? sr : 44100;
}

function getRmsWindows(filePath, windowMs) {
  const sampleRate = getSampleRate(filePath);
  const windowSamples = Math.max(1, Math.floor(sampleRate * windowMs / 1000));

  const result = execSync(
    `ffmpeg -i "${filePath}" -af "asetnsamples=n=${windowSamples}:p=0,astats=metadata=1:reset=1,ametadata=print" -f null - 2>&1`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );

  const rms = [];
  const matches = result.matchAll(/lavfi\.astats\.1\.RMS_level=([-\d.]+|nan)/g);
  for (const match of matches) {
    const value = match[1] === 'nan' ? MIN_DB : parseFloat(match[1]);
    if (Number.isFinite(value)) {
      rms.push(Math.max(MIN_DB, value));
    }
  }

  return { rms, sampleRate };
}

function percentile(sorted, p) {
  if (!sorted.length) return MIN_DB;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}

function toAudioLevel(rmsDb, noiseFloorDb) {
  const thresholdDb = noiseFloorDb + VISUAL_NOISE_MARGIN_DB;
  if (rmsDb <= thresholdDb) return 0;
  const normalized = Math.min(1, (rmsDb - thresholdDb) / VISUAL_DYNAMIC_RANGE_DB);
  return Math.pow(normalized, 0.7);
}

function analyzeFile(filePath) {
  const fileName = path.basename(filePath);
  const { rms, sampleRate } = getRmsWindows(filePath, WINDOW_MS);
  if (!rms.length) {
    return { fileName, error: 'no_rms' };
  }

  const sorted = [...rms].sort((a, b) => a - b);
  const noiseFloorDb = percentile(sorted, NOISE_PERCENTILE);
  const thresholdDb = noiseFloorDb + VISUAL_NOISE_MARGIN_DB;

  const startWindows = Math.max(1, Math.floor((START_SECONDS * 1000) / WINDOW_MS));
  const levels = rms.map(db => toAudioLevel(db, noiseFloorDb));

  const startSlice = levels.slice(0, startWindows);
  const startMax = startSlice.length ? Math.max(...startSlice) : 0;
  const startAvg = startSlice.length
    ? startSlice.reduce((a, b) => a + b, 0) / startSlice.length
    : 0;

  const pulseCount = levels.filter(l => l > 0.1).length;
  const glowCount = levels.filter(l => l > 0.2).length;
  const pulsePct = (pulseCount / levels.length) * 100;
  const glowPct = (glowCount / levels.length) * 100;

  return {
    fileName,
    noiseFloorDb,
    thresholdDb,
    startAvg,
    startMax,
    pulsePct,
    glowPct,
    sampleRate,
  };
}

function formatDb(db) {
  if (!Number.isFinite(db)) return 'NaN';
  const rounded = Math.round(db * 10) / 10;
  return `${rounded.toFixed(1)}`;
}

function formatPct(value) {
  return `${value.toFixed(0)}%`;
}

function main() {
  const directory = process.argv[2] || './temp/mozart';
  const files = fs.readdirSync(directory)
    .filter(f => f.endsWith('.mp3'))
    .map(f => path.join(directory, f))
    .sort();

  if (!files.length) {
    console.log('No MP3 files found in', directory);
    return;
  }

  console.log('='.repeat(110));
  console.log('VISUAL LEVEL SIMULATION (pulse/glow)'.padEnd(110));
  console.log('='.repeat(110));
  console.log(`Directory: ${directory}`);
  console.log(`Window: ${WINDOW_MS}ms | Noise percentile: ${Math.round(NOISE_PERCENTILE * 100)}% | Margin: +${VISUAL_NOISE_MARGIN_DB}dB`);
  console.log(`Start window: ${START_SECONDS}s`);
  console.log('='.repeat(110));
  console.log('');
  console.log('Track                   | NoiseFloor | Threshold | StartAvg | StartMax | Pulse% | Glow%');
  console.log('------------------------|-----------|-----------|---------|---------|-------|------');

  for (const file of files) {
    const r = analyzeFile(file);
    const name = r.fileName.replace('.mp3', '').padEnd(23).slice(0, 23);
    if (r.error) {
      console.log(`${name} | ${'ERR'.padStart(9)} | ${'ERR'.padStart(9)} | ${'ERR'.padStart(7)} | ${'ERR'.padStart(7)} | ${'ERR'.padStart(5)} | ${'ERR'.padStart(4)}`);
      continue;
    }
    const noise = formatDb(r.noiseFloorDb).padStart(9);
    const threshold = formatDb(r.thresholdDb).padStart(9);
    const startAvg = r.startAvg.toFixed(2).padStart(7);
    const startMax = r.startMax.toFixed(2).padStart(7);
    const pulse = formatPct(r.pulsePct).padStart(5);
    const glow = formatPct(r.glowPct).padStart(4);

    console.log(`${name} | ${noise} | ${threshold} | ${startAvg} | ${startMax} | ${pulse} | ${glow}`);
  }

  console.log('');
  console.log('Notes: StartAvg/StartMax are normalized animation levels (0..1). Pulse>0.1, Glow>0.2.');
}

main();
