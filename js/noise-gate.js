// Noise Gate - Buffer pre-processing for removing background noise
// Especially useful for Aalto anechoic recordings which have uniform gain settings

/**
 * Apply noise gate to an audio buffer
 * Silences sections where the signal is below the threshold
 *
 * @param {AudioBuffer} audioBuffer - The audio buffer to process
 * @param {Object} options - Gate options
 * @param {number} options.thresholdDb - Threshold in dB (default -50)
 * @param {number} options.attackMs - Attack time in ms (default 2)
 * @param {number} options.holdMs - Hold time in ms (default 30)
 * @param {number} options.releaseMs - Release time in ms (default 50)
 * @param {number} options.windowMs - RMS window size in ms (default 10)
 * @returns {AudioBuffer} - New processed audio buffer
 */
export function applyNoiseGate(audioBuffer, options = {}) {
  const {
    thresholdDb = -50,
    attackMs = 2,
    holdMs = 30,
    releaseMs = 50,
    windowMs = 10,
  } = options;

  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  // Convert times to samples
  const attackSamples = Math.floor(attackMs * sampleRate / 1000);
  const holdSamples = Math.floor(holdMs * sampleRate / 1000);
  const releaseSamples = Math.floor(releaseMs * sampleRate / 1000);
  const windowSamples = Math.floor(windowMs * sampleRate / 1000);

  // Convert threshold from dB to linear
  const threshold = Math.pow(10, thresholdDb / 20);

  // Create a new buffer for the output
  const ctx = new OfflineAudioContext(numChannels, length, sampleRate);
  const outputBuffer = ctx.createBuffer(numChannels, length, sampleRate);

  // First pass: compute RMS envelope across all channels
  const envelope = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);

    for (let i = 0; i < length; i++) {
      envelope[i] += channelData[i] * channelData[i];
    }
  }

  // Normalize by number of channels
  for (let i = 0; i < length; i++) {
    envelope[i] = Math.sqrt(envelope[i] / numChannels);
  }

  // Compute RMS in sliding window
  const rmsEnvelope = new Float32Array(length);
  let windowSum = 0;

  // Initialize window
  for (let i = 0; i < Math.min(windowSamples, length); i++) {
    windowSum += envelope[i] * envelope[i];
  }

  for (let i = 0; i < length; i++) {
    // Compute RMS for current window
    const windowStart = Math.max(0, i - windowSamples / 2);
    const windowEnd = Math.min(length, i + windowSamples / 2);
    const windowLen = windowEnd - windowStart;

    let sum = 0;
    for (let j = windowStart; j < windowEnd; j++) {
      sum += envelope[j] * envelope[j];
    }
    rmsEnvelope[i] = Math.sqrt(sum / windowLen);
  }

  // Second pass: compute gate gain envelope
  const gateGain = new Float32Array(length);
  let gateState = 0; // 0 = closed, 1 = opening, 2 = open, 3 = holding, 4 = closing
  let stateCounter = 0;
  let currentGain = 0;

  for (let i = 0; i < length; i++) {
    const level = rmsEnvelope[i];
    const aboveThreshold = level > threshold;

    switch (gateState) {
      case 0: // Closed
        if (aboveThreshold) {
          gateState = 1; // Start opening
          stateCounter = 0;
        }
        currentGain = 0;
        break;

      case 1: // Opening (attack)
        stateCounter++;
        currentGain = Math.min(1, stateCounter / attackSamples);
        if (stateCounter >= attackSamples) {
          gateState = 2; // Fully open
        }
        break;

      case 2: // Open
        currentGain = 1;
        if (!aboveThreshold) {
          gateState = 3; // Start hold
          stateCounter = 0;
        }
        break;

      case 3: // Holding
        currentGain = 1;
        stateCounter++;
        if (aboveThreshold) {
          gateState = 2; // Back to open
        } else if (stateCounter >= holdSamples) {
          gateState = 4; // Start closing
          stateCounter = 0;
        }
        break;

      case 4: // Closing (release)
        stateCounter++;
        currentGain = Math.max(0, 1 - stateCounter / releaseSamples);
        if (aboveThreshold) {
          gateState = 1; // Re-open
          stateCounter = Math.floor((1 - currentGain) * attackSamples);
        } else if (stateCounter >= releaseSamples) {
          gateState = 0; // Fully closed
          currentGain = 0;
        }
        break;
    }

    gateGain[i] = currentGain;
  }

  // Apply smoothing to gate gain to avoid clicks
  const smoothedGain = new Float32Array(length);
  const smoothingSamples = Math.floor(2 * sampleRate / 1000); // 2ms smoothing

  for (let i = 0; i < length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - smoothingSamples); j <= Math.min(length - 1, i + smoothingSamples); j++) {
      sum += gateGain[j];
      count++;
    }
    smoothedGain[i] = sum / count;
  }

  // Third pass: apply gate to all channels
  for (let ch = 0; ch < numChannels; ch++) {
    const inputData = audioBuffer.getChannelData(ch);
    const outputData = outputBuffer.getChannelData(ch);

    for (let i = 0; i < length; i++) {
      outputData[i] = inputData[i] * smoothedGain[i];
    }
  }

  return outputBuffer;
}

/**
 * Copy an AudioBuffer
 * @param {AudioBuffer} buffer - Buffer to copy
 * @returns {AudioBuffer} - New copied buffer
 */
export function copyAudioBuffer(buffer) {
  const ctx = new OfflineAudioContext(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate
  );
  const copy = ctx.createBuffer(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate
  );

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    copy.getChannelData(ch).set(buffer.getChannelData(ch));
  }

  return copy;
}

/**
 * Estimate noise floor of an audio buffer
 * Useful for auto-setting threshold
 *
 * @param {AudioBuffer} buffer - Audio buffer to analyze
 * @returns {number} - Estimated noise floor in dB
 */
export function estimateNoiseFloor(buffer) {
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;

  // Analyze in 50ms windows
  const windowSize = Math.floor(0.05 * sampleRate);
  const numWindows = Math.floor(length / windowSize);

  const rmsValues = [];

  for (let w = 0; w < numWindows; w++) {
    const start = w * windowSize;
    let sum = 0;

    for (let ch = 0; ch < numChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = start; i < start + windowSize; i++) {
        sum += data[i] * data[i];
      }
    }

    const rms = Math.sqrt(sum / (windowSize * numChannels));
    if (rms > 0) {
      rmsValues.push(rms);
    }
  }

  // Sort and take the 10th percentile as noise floor estimate
  rmsValues.sort((a, b) => a - b);
  const percentileIndex = Math.floor(rmsValues.length * 0.1);
  const noiseFloorLinear = rmsValues[percentileIndex] || 0.0001;

  // Convert to dB
  const noiseFloorDb = 20 * Math.log10(noiseFloorLinear);

  return noiseFloorDb;
}

/**
 * Default noise gate options
 */
export const DEFAULT_NOISE_GATE_OPTIONS = {
  thresholdDb: -48,
  attackMs: 2,
  holdMs: 30,
  releaseMs: 50,
  windowMs: 10,
};
