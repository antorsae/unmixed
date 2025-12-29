// Reverb system with impulse response generation

/**
 * Reverb preset configurations
 */
export const REVERB_PRESETS = {
  'none': {
    name: 'None',
    duration: 0,
    decay: 0,
    wet: 0,
  },
  'small-room': {
    name: 'Small Room',
    duration: 0.4,
    decay: 2.0,
    wet: 0.3,
    predelay: 0.005,
    earlyReflections: 0.1,
  },
  'chamber': {
    name: 'Chamber',
    duration: 1.0,
    decay: 2.5,
    wet: 0.35,
    predelay: 0.01,
    earlyReflections: 0.15,
  },
  'concert-hall': {
    name: 'Concert Hall',
    duration: 2.2,
    decay: 3.0,
    wet: 0.4,
    predelay: 0.02,
    earlyReflections: 0.2,
  },
  'cathedral': {
    name: 'Cathedral',
    duration: 4.0,
    decay: 4.0,
    wet: 0.45,
    predelay: 0.04,
    earlyReflections: 0.25,
  },
  'outdoor-amphitheater': {
    name: 'Outdoor Amphitheater',
    duration: 1.5,
    decay: 2.0,
    wet: 0.35,
    predelay: 0.03,
    earlyReflections: 0.3,
    sparse: true,
  },
};

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

  // Generate noise-based impulse response
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;

    // Exponential decay envelope
    const decay = Math.exp(-t * preset.decay);

    // Add some early reflections
    let early = 0;
    if (preset.earlyReflections && t < 0.1) {
      const earlyDecay = Math.exp(-t * 20);
      early = preset.earlyReflections * earlyDecay;

      // Add discrete early reflections
      const reflectionTimes = [0.01, 0.02, 0.035, 0.05, 0.07, 0.09];
      for (const rt of reflectionTimes) {
        if (Math.abs(t - rt) < 0.001) {
          early += 0.3 * Math.exp(-rt * 10);
        }
      }
    }

    // Predelay
    let sample = 0;
    if (t >= preset.predelay) {
      // White noise with decay
      const noise = (Math.random() * 2 - 1);

      // For sparse reverb (outdoor), make it more sparse
      if (preset.sparse) {
        sample = noise * decay * (Math.random() > 0.7 ? 1 : 0.1);
      } else {
        sample = noise * decay;
      }
    }

    // Combine
    const left = sample + early * (Math.random() * 2 - 1);
    const right = sample + early * (Math.random() * 2 - 1);

    leftChannel[i] = left;
    rightChannel[i] = right;
  }

  // Normalize
  normalizeBuffer(buffer);

  return buffer;
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
