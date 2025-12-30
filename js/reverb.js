// Reverb system with impulse response generation

/**
 * Reverb preset configurations
 */
export const REVERB_PRESETS = {
  'none': {
    name: 'None',
    duration: 0,
    rt60: 0,
    wet: 0,
  },
  'small-room': {
    name: 'Small Room',
    duration: 0.8,
    rt60: 0.6,
    hfDecay: 3.0,
    lowpassHz: 2000,
    wet: 0.16,
    predelay: 0.005,
    earlyReflections: 0.1,
  },
  'chamber': {
    name: 'Chamber',
    duration: 1.6,
    rt60: 1.2,
    hfDecay: 2.6,
    lowpassHz: 1800,
    wet: 0.2,
    predelay: 0.01,
    earlyReflections: 0.15,
  },
  'concert-hall': {
    name: 'Concert Hall',
    duration: 2.8,
    rt60: 2.2,
    hfDecay: 2.2,
    lowpassHz: 1500,
    wet: 0.27,
    predelay: 0.02,
    earlyReflections: 0.2,
  },
  'cathedral': {
    name: 'Cathedral',
    duration: 7.0,
    rt60: 5.5,
    hfDecay: 1.8,
    lowpassHz: 1200,
    wet: 0.36,
    predelay: 0.04,
    earlyReflections: 0.25,
  },
  'outdoor-amphitheater': {
    name: 'Outdoor Amphitheater',
    duration: 1.6,
    rt60: 1.2,
    hfDecay: 3.2,
    lowpassHz: 2200,
    wet: 0.18,
    predelay: 0.03,
    earlyReflections: 0.3,
    sparse: true,
  },
};

const RT60_DECAY = Math.log(1000);
const DEFAULT_HF_DECAY = 2.5;
const DEFAULT_LOWPASS_HZ = 1500;
const DEFAULT_REFLECTIONS = [
  { time: 0.008, gain: 0.6, pan: -0.3 },
  { time: 0.012, gain: 0.5, pan: 0.25 },
  { time: 0.020, gain: 0.45, pan: -0.2 },
  { time: 0.028, gain: 0.35, pan: 0.2 },
  { time: 0.040, gain: 0.3, pan: -0.15 },
  { time: 0.055, gain: 0.25, pan: 0.1 },
  { time: 0.075, gain: 0.2, pan: -0.05 },
];

/**
 * Generate an impulse response buffer for a reverb preset
 * @param {AudioContext} audioContext - Audio context
 * @param {string} presetName - Preset name
 * @returns {AudioBuffer} - Impulse response buffer
 */
export function generateImpulseResponse(audioContext, presetName) {
  const preset = REVERB_PRESETS[presetName];

  if (!preset || preset.duration === 0) {
    return null;
  }

  const sampleRate = audioContext.sampleRate;
  const length = Math.ceil(preset.duration * sampleRate);
  const buffer = audioContext.createBuffer(2, length, sampleRate);

  const leftChannel = buffer.getChannelData(0);
  const rightChannel = buffer.getChannelData(1);

  const preDelay = preset.predelay || 0;
  const rt60 = Math.max(0.001, preset.rt60 || 1.5);
  const decayCoeff = RT60_DECAY / rt60;
  const hfDecay = preset.hfDecay || DEFAULT_HF_DECAY;
  const lowpassHz = preset.lowpassHz || DEFAULT_LOWPASS_HZ;
  const lowpassAlpha = calculateLowpassAlpha(lowpassHz, sampleRate);
  const reflections = buildEarlyReflections(preset, sampleRate, preDelay, length);

  let reflectionIndex = 0;
  let lowL = 0;
  let lowR = 0;

  // Generate noise-based impulse response with frequency-dependent decay
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let tailL = 0;
    let tailR = 0;

    // Predelay for reverb tail
    if (t >= preDelay) {
      const tailTime = t - preDelay;
      const decayLow = Math.exp(-tailTime * decayCoeff);
      const decayHigh = Math.exp(-tailTime * decayCoeff * hfDecay);

      let noiseL = (Math.random() * 2 - 1);
      let noiseR = (Math.random() * 2 - 1);

      // For sparse reverb (outdoor), make it more sparse
      if (preset.sparse) {
        noiseL *= (Math.random() > 0.7 ? 1 : 0.1);
        noiseR *= (Math.random() > 0.7 ? 1 : 0.1);
      }

      lowL += lowpassAlpha * (noiseL - lowL);
      lowR += lowpassAlpha * (noiseR - lowR);

      const highL = noiseL - lowL;
      const highR = noiseR - lowR;

      tailL = (lowL * decayLow) + (highL * decayHigh);
      tailR = (lowR * decayLow) + (highR * decayHigh);
    }

    let earlyL = 0;
    let earlyR = 0;
    while (reflectionIndex < reflections.length && reflections[reflectionIndex].index === i) {
      const ref = reflections[reflectionIndex];
      earlyL += ref.gainL;
      earlyR += ref.gainR;
      reflectionIndex += 1;
    }

    leftChannel[i] = tailL + earlyL;
    rightChannel[i] = tailR + earlyR;
  }

  // Normalize
  normalizeBuffer(buffer);

  return buffer;
}

function calculateLowpassAlpha(cutoffHz, sampleRate) {
  const clamped = Math.max(20, Math.min(cutoffHz, sampleRate / 2 - 100));
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * clamped);
  return dt / (rc + dt);
}

function buildEarlyReflections(preset, sampleRate, preDelay, length) {
  if (!preset.earlyReflections) return [];

  const pattern = preset.reflections || DEFAULT_REFLECTIONS;
  const reflections = [];

  for (const ref of pattern) {
    const index = Math.round((preDelay + ref.time) * sampleRate);
    if (index < 0 || index >= length) continue;

    const pan = clamp(ref.pan || 0, -0.8, 0.8);
    const decay = Math.exp(-ref.time * 12);
    const gain = ref.gain * preset.earlyReflections * decay;
    const gainL = gain * (1 - pan);
    const gainR = gain * (1 + pan);
    reflections.push({ index, gainL, gainR });
  }

  reflections.sort((a, b) => a.index - b.index);
  return reflections;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalize an audio buffer to prevent clipping
 * @param {AudioBuffer} buffer - Buffer to normalize
 */
function normalizeBuffer(buffer) {
  const numChannels = buffer.numberOfChannels;
  let maxVal = 0;

  // Find max value
  for (let c = 0; c < numChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      maxVal = Math.max(maxVal, Math.abs(data[i]));
    }
  }

  // Normalize
  if (maxVal > 0) {
    const gain = 1 / maxVal;
    for (let c = 0; c < numChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        data[i] *= gain;
      }
    }
  }
}

/**
 * Create a reverb manager
 */
export class ReverbManager {
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.impulseResponses = new Map();
    this.currentPreset = 'concert-hall';
  }

  /**
   * Get or generate an impulse response for a preset
   * @param {string} presetName - Preset name
   * @returns {AudioBuffer|null} - Impulse response
   */
  getImpulseResponse(presetName) {
    if (presetName === 'none') {
      return null;
    }

    if (!this.impulseResponses.has(presetName)) {
      const ir = generateImpulseResponse(this.audioContext, presetName);
      this.impulseResponses.set(presetName, ir);
    }

    return this.impulseResponses.get(presetName);
  }

  /**
   * Get preset info
   * @param {string} presetName - Preset name
   * @returns {Object} - Preset info
   */
  getPresetInfo(presetName) {
    return REVERB_PRESETS[presetName] || REVERB_PRESETS['none'];
  }

  /**
   * Get all preset names
   * @returns {Array<string>} - Preset names
   */
  getPresetNames() {
    return Object.keys(REVERB_PRESETS);
  }

  /**
   * Clear cached impulse responses
   */
  clearCache() {
    this.impulseResponses.clear();
  }
}
