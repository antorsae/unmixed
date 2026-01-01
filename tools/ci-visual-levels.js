#!/usr/bin/env node
/**
 * CI sanity check for StageCanvas pulse/glow at playback start.
 * Ensures the first second stays below a small visual threshold.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WINDOW_MS = 50;
const START_SECONDS = 1.0;
const NOISE_PERCENTILE = 0.1;
const MIN_DB = -120;

function readVisualConstants() {
  const defaults = {
    VISUAL_NOISE_MARGIN_DB: 12,
    VISUAL_DYNAMIC_RANGE_DB: 40,
  };

  try {
    const sourcePath = path.join(__dirname, '..', 'js', 'audio-engine.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const readConst = (name, fallback) => {
      const regex = new RegExp(`const\\s+${name}\\s*=\\s*([-.\\d]+)`);
      const match = source.match(regex);
      const value = match ? parseFloat(match[1]) : NaN;
      return Number.isFinite(value) ? value : fallback;
    };

    return {
      VISUAL_NOISE_MARGIN_DB: readConst('VISUAL_NOISE_MARGIN_DB', defaults.VISUAL_NOISE_MARGIN_DB),
      VISUAL_DYNAMIC_RANGE_DB: readConst('VISUAL_DYNAMIC_RANGE_DB', defaults.VISUAL_DYNAMIC_RANGE_DB),
    };
  } catch (error) {
    console.warn('Warning: Unable to read visual constants from audio-engine.js:', error.message);
    return defaults;
  }
}

const { VISUAL_NOISE_MARGIN_DB, VISUAL_DYNAMIC_RANGE_DB } = readVisualConstants();

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

function parseArgs(args) {
  let directory = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--max-start' || arg === '--max-start-avg' || arg === '--min-files') {
      i += 1;
      continue;
    }
    if (!arg.startsWith('--') && !directory) {
      directory = arg;
    }
  }

  const getArg = (flag, fallback) => {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx === args.length - 1) return fallback;
    return args[idx + 1];
  };

  return {
    directory: directory || './temp/mozart',
    maxStart: parseFloat(getArg('--max-start', '0.05')),
    maxStartAvg: parseFloat(getArg('--max-start-avg', '0.02')),
    minFiles: parseInt(getArg('--min-files', '5'), 10),
  };
}

function analyzeFile(filePath) {
  const fileName = path.basename(filePath);
  const { rms } = getRmsWindows(filePath, WINDOW_MS);
  if (!rms.length) {
    return { fileName, error: 'no_rms' };
  }

  const sorted = [...rms].sort((a, b) => a - b);
  const noiseFloorDb = percentile(sorted, NOISE_PERCENTILE);

  const startWindows = Math.max(1, Math.floor((START_SECONDS * 1000) / WINDOW_MS));
  const levels = rms.map(db => toAudioLevel(db, noiseFloorDb));
  const startSlice = levels.slice(0, startWindows);

  const startMax = startSlice.length ? Math.max(...startSlice) : 0;
  const startAvg = startSlice.length
    ? startSlice.reduce((a, b) => a + b, 0) / startSlice.length
    : 0;

  return { fileName, startAvg, startMax };
}

function main() {
  const { directory, maxStart, maxStartAvg, minFiles } = parseArgs(process.argv.slice(2));

  const files = fs.readdirSync(directory)
    .filter(f => f.endsWith('.mp3'))
    .map(f => path.join(directory, f))
    .sort();

  if (files.length < minFiles) {
    console.error(`Expected at least ${minFiles} mp3 files in ${directory}, found ${files.length}.`);
    process.exit(1);
  }

  const violations = [];
  let maxObserved = 0;

  for (const file of files) {
    const r = analyzeFile(file);
    if (r.error) {
      violations.push({ file: r.fileName, reason: r.error });
      continue;
    }
    maxObserved = Math.max(maxObserved, r.startMax);
    if (r.startMax > maxStart || r.startAvg > maxStartAvg) {
      violations.push({
        file: r.fileName,
        startAvg: r.startAvg,
        startMax: r.startMax,
      });
    }
  }

  if (violations.length) {
    console.error(`Found ${violations.length} start-level violations (maxStart=${maxStart}, maxStartAvg=${maxStartAvg}).`);
    for (const v of violations) {
      if (v.reason) {
        console.error(`- ${v.file}: ${v.reason}`);
      } else {
        console.error(`- ${v.file}: startAvg=${v.startAvg.toFixed(3)} startMax=${v.startMax.toFixed(3)}`);
      }
    }
    process.exit(1);
  }

  console.log(`OK: ${files.length} files checked. Max start level: ${maxObserved.toFixed(3)}.`);
}

main();
