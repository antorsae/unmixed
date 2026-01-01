const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_MIN_DB = -100;
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

function listAudioFiles(directory, extensions = ['.mp3']) {
  const allowed = new Set(extensions.map(ext => ext.toLowerCase()));
  return fs.readdirSync(directory)
    .filter(file => allowed.has(path.extname(file).toLowerCase()))
    .map(file => path.join(directory, file))
    .sort();
}

function getProbe(filePath) {
  try {
    const result = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
      { encoding: 'utf8', maxBuffer: DEFAULT_MAX_BUFFER }
    );
    return JSON.parse(result);
  } catch (e) {
    console.error(`Error getting probe data for ${filePath}:`, e.message);
    return null;
  }
}

function getAudioInfo(filePath, fallbackSampleRate = DEFAULT_SAMPLE_RATE) {
  const probe = getProbe(filePath);
  if (!probe) {
    return { duration: 0, sampleRate: fallbackSampleRate };
  }

  const duration = parseFloat(probe.format?.duration || 0);
  const sampleRate = parseInt(probe.streams?.[0]?.sample_rate || fallbackSampleRate, 10);
  return { duration, sampleRate };
}

function getVolumeStats(filePath) {
  try {
    const result = execSync(
      `ffmpeg -i "${filePath}" -af "volumedetect" -f null - 2>&1`,
      { encoding: 'utf8', maxBuffer: DEFAULT_MAX_BUFFER }
    );

    const meanMatch = result.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    const maxMatch = result.match(/max_volume:\s*([-\d.]+)\s*dB/);

    return {
      meanVolume: meanMatch ? parseFloat(meanMatch[1]) : null,
      maxVolume: maxMatch ? parseFloat(maxMatch[1]) : null,
    };
  } catch (e) {
    console.error(`Error analyzing volume for ${filePath}:`, e.message);
    return { meanVolume: null, maxVolume: null };
  }
}

function parseDbToken(token, { minDb = DEFAULT_MIN_DB } = {}) {
  if (!token) return null;
  const normalized = token.toString().trim().toLowerCase();
  if (normalized === '-inf' || normalized === '-infinity') return minDb;
  if (normalized === 'inf' || normalized === '+inf' || normalized === 'infinity' || normalized === '+infinity') return 0;
  if (normalized === 'nan') return null;
  const value = parseFloat(token);
  return Number.isFinite(value) ? value : null;
}

function parseDbLevels(output, regex, { minDb = DEFAULT_MIN_DB, discardBelowMin = false } = {}) {
  const levels = [];
  for (const match of output.matchAll(regex)) {
    const raw = match[1];
    const value = parseDbToken(raw, { minDb });
    if (value === null) continue;
    if (discardBelowMin && value <= minDb) continue;
    levels.push(value);
  }
  return levels;
}

function getWindowRmsLevels(filePath, windowMs, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      sampleRate,
      minDb = DEFAULT_MIN_DB,
      discardBelowMin = false,
      fallbackToPeak = false,
      minLevels = 10,
    } = options;

    const resolvedSampleRate = Number.isFinite(sampleRate)
      ? sampleRate
      : getAudioInfo(filePath).sampleRate || DEFAULT_SAMPLE_RATE;
    const windowSamples = Math.max(1, Math.floor(resolvedSampleRate * windowMs / 1000));

    const readAmetadataLevels = (key) => new Promise((resolveLevels, rejectLevels) => {
      const filter = [
        `asetnsamples=n=${windowSamples}:p=0`,
        'astats=metadata=1:reset=1',
        `ametadata=print:key=${key}`,
      ].join(',');

      const ffmpeg = spawn('ffmpeg', [
        '-i', filePath,
        '-af', filter,
        '-f', 'null',
        '-'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let stderr = '';

      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', () => {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`${escapedKey}=([\\w.+-]+)`, 'g');
        const levels = parseDbLevels(stderr, regex, { minDb, discardBelowMin });
        resolveLevels(levels);
      });

      ffmpeg.on('error', rejectLevels);
    });

    readAmetadataLevels('lavfi.astats.Overall.RMS_level')
      .then((levels) => {
        if (!fallbackToPeak || levels.length >= minLevels) {
          resolve(levels);
          return null;
        }
        return readAmetadataLevels('lavfi.astats.Overall.Peak_level')
          .then((peakLevels) => {
            levels.push(...peakLevels);
            resolve(levels);
          });
      })
      .catch(reject);
  });
}

function getAstatsSummary(filePath) {
  try {
    const result = execSync(
      `ffmpeg -i "${filePath}" -af "astats" -f null - 2>&1`,
      { encoding: 'utf8', maxBuffer: DEFAULT_MAX_BUFFER }
    );

    const readValue = (regex) => {
      const match = result.match(regex);
      return match ? parseDbToken(match[1]) : null;
    };

    return {
      noiseFloor: readValue(/Noise floor dB:\s*([-\w.+]+)/i),
      rmsLevel: readValue(/RMS level dB:\s*([-\w.+]+)/i),
      rmsPeak: readValue(/RMS peak dB:\s*([-\w.+]+)/i),
      rmsTrough: readValue(/RMS trough dB:\s*([-\w.+]+)/i),
      peakLevel: readValue(/Peak level dB:\s*([-\w.+]+)/i),
    };
  } catch (e) {
    console.error(`Error running astats for ${filePath}:`, e.message);
    return {
      noiseFloor: null,
      rmsLevel: null,
      rmsPeak: null,
      rmsTrough: null,
      peakLevel: null,
    };
  }
}

function getPercentile(sortedLevels, percentile) {
  if (!sortedLevels.length) return null;
  const clamped = Math.min(1, Math.max(0, percentile));
  const index = Math.min(sortedLevels.length - 1, Math.max(0, Math.floor(sortedLevels.length * clamped)));
  return sortedLevels[index];
}

function summarizeLevels(levels, percentiles = [0.1, 0.5, 0.9]) {
  const sorted = [...levels].sort((a, b) => a - b);
  const summary = { sorted, count: sorted.length };
  for (const percentile of percentiles) {
    const key = `p${Math.round(percentile * 100)}`;
    summary[key] = getPercentile(sorted, percentile);
  }
  return summary;
}

function averageOfLowest(sortedLevels, fraction) {
  if (!sortedLevels.length) return null;
  const clamped = Math.min(1, Math.max(0, fraction));
  const count = Math.max(1, Math.floor(sortedLevels.length * clamped));
  const slice = sortedLevels.slice(0, count);
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / slice.length;
}

module.exports = {
  listAudioFiles,
  getProbe,
  getAudioInfo,
  getVolumeStats,
  getWindowRmsLevels,
  getAstatsSummary,
  parseDbToken,
  parseDbLevels,
  getPercentile,
  summarizeLevels,
  averageOfLowest,
};
