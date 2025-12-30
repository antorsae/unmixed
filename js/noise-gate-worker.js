// Noise Gate Web Worker - Optimized O(n) algorithm
// Uses sliding window for RMS and smoothing to avoid O(n*window) complexity

/**
 * Compute sum of squares from channel data, normalized by channel count
 * @param {Float32Array[]} channelData - Array of channel buffers
 * @returns {Float32Array} Sum of squares per sample
 */
function computeSumSq(channelData) {
  const numChannels = channelData.length;
  const length = channelData[0].length;
  const sumSq = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const data = channelData[ch];
    for (let i = 0; i < length; i++) {
      sumSq[i] += data[i] * data[i];
    }
  }

  // Normalize by channels
  const invChannels = 1 / numChannels;
  for (let i = 0; i < length; i++) {
    sumSq[i] *= invChannels;
  }

  return sumSq;
}

/**
 * Compute sliding window RMS² from sum of squares
 * @param {Float32Array} sumSq - Sum of squares per sample
 * @param {number} halfWindow - Half window size in samples
 * @returns {Float32Array} RMS² per sample
 */
function computeRmsSq(sumSq, halfWindow) {
  const length = sumSq.length;
  const rmsSq = new Float32Array(length);
  let windowSum = 0;

  // Initialize window [0, halfWindow)
  for (let i = 0; i < halfWindow && i < length; i++) {
    windowSum += sumSq[i];
  }

  for (let i = 0; i < length; i++) {
    // Add sample entering window on the right
    const addIdx = i + halfWindow;
    if (addIdx < length) {
      windowSum += sumSq[addIdx];
    }

    // Remove sample leaving window on the left
    const removeIdx = i - halfWindow - 1;
    if (removeIdx >= 0) {
      windowSum -= sumSq[removeIdx];
    }

    // Window size varies at edges
    const winStart = Math.max(0, i - halfWindow);
    const winEnd = Math.min(length, i + halfWindow + 1);
    const winLen = winEnd - winStart;

    rmsSq[i] = windowSum / winLen;
  }

  return rmsSq;
}

/**
 * Compute gate gain using state machine
 * @param {Float32Array} rmsSq - RMS² per sample
 * @param {number} thresholdSq - Threshold squared
 * @param {number} attackSamples - Attack time in samples
 * @param {number} holdSamples - Hold time in samples
 * @param {number} releaseSamples - Release time in samples
 * @returns {Float32Array} Gate gain per sample
 */
function computeGateGain(rmsSq, thresholdSq, attackSamples, holdSamples, releaseSamples) {
  const length = rmsSq.length;
  const gateGain = new Float32Array(length);
  let state = 0; // 0=closed, 1=opening, 2=open, 3=holding, 4=closing
  let counter = 0;
  let gain = 0;

  // Precompute reciprocals for division
  const invAttack = 1 / attackSamples;
  const invRelease = 1 / releaseSamples;

  for (let i = 0; i < length; i++) {
    const aboveThreshold = rmsSq[i] > thresholdSq;

    switch (state) {
      case 0: // Closed
        if (aboveThreshold) {
          state = 1;
          counter = 0;
        }
        gain = 0;
        break;

      case 1: // Opening
        counter++;
        gain = counter * invAttack;
        if (gain >= 1) {
          gain = 1;
          state = 2;
        }
        break;

      case 2: // Open
        gain = 1;
        if (!aboveThreshold) {
          state = 3;
          counter = 0;
        }
        break;

      case 3: // Holding
        gain = 1;
        counter++;
        if (aboveThreshold) {
          state = 2;
        } else if (counter >= holdSamples) {
          state = 4;
          counter = 0;
        }
        break;

      case 4: // Closing
        counter++;
        gain = 1 - counter * invRelease;
        if (gain <= 0) {
          gain = 0;
          state = 0;
        } else if (aboveThreshold) {
          state = 1;
          counter = Math.floor((1 - gain) * attackSamples);
        }
        break;
    }

    gateGain[i] = gain;
  }

  return gateGain;
}

/**
 * Apply sliding window smoothing to gate gain
 * @param {Float32Array} gateGain - Gate gain per sample
 * @param {number} smoothingSamples - Smoothing window size in samples
 * @returns {Float32Array} Smoothed gate gain
 */
function smoothGateGain(gateGain, smoothingSamples) {
  const length = gateGain.length;
  const smoothedGain = new Float32Array(length);
  let smoothSum = 0;

  // Initialize window
  for (let i = 0; i < smoothingSamples && i < length; i++) {
    smoothSum += gateGain[i];
  }

  for (let i = 0; i < length; i++) {
    // Add sample entering window
    const addIdx = i + smoothingSamples;
    if (addIdx < length) {
      smoothSum += gateGain[addIdx];
    }

    // Remove sample leaving window
    const removeIdx = i - smoothingSamples - 1;
    if (removeIdx >= 0) {
      smoothSum -= gateGain[removeIdx];
    }

    // Window size at edges
    const winStart = Math.max(0, i - smoothingSamples);
    const winEnd = Math.min(length, i + smoothingSamples + 1);
    const winLen = winEnd - winStart;

    smoothedGain[i] = smoothSum / winLen;
  }

  return smoothedGain;
}

/**
 * Apply gate gain to channel data
 * @param {Float32Array[]} channelData - Input channel buffers
 * @param {Float32Array} smoothedGain - Smoothed gate gain
 * @returns {Float32Array[]} Output channel buffers
 */
function applyGateToChannels(channelData, smoothedGain) {
  const numChannels = channelData.length;
  const length = channelData[0].length;
  const gainLength = smoothedGain.length;
  const outputData = [];

  for (let ch = 0; ch < numChannels; ch++) {
    const input = channelData[ch];
    const output = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      // Clamp index to smoothedGain length to handle buffers longer than envelope
      const gainIdx = Math.min(i, gainLength - 1);
      output[i] = input[i] * smoothedGain[gainIdx];
    }
    outputData.push(output);
  }

  return outputData;
}

self.onmessage = function(e) {
  const { type } = e.data;

  // Handle multi-buffer case for directivity coherence
  if (type === 'applyNoiseGateMulti') {
    handleMultiBuffer(e.data);
    return;
  }

  // Default: single buffer processing (backward compatible)
  handleSingleBuffer(e.data);
};

/**
 * Handle single buffer noise gate (original behavior)
 */
function handleSingleBuffer(data) {
  const { channelData, sampleRate, options, taskId } = data;

  const {
    thresholdDb = -48,
    attackMs = 5,
    holdMs = 100,
    releaseMs = 80,
    windowMs = 20,
  } = options;

  const length = channelData[0].length;

  // Convert times to samples
  const attackSamples = Math.max(1, Math.floor(attackMs * sampleRate / 1000));
  const holdSamples = Math.max(1, Math.floor(holdMs * sampleRate / 1000));
  const releaseSamples = Math.max(1, Math.floor(releaseMs * sampleRate / 1000));
  const halfWindow = Math.max(1, Math.floor(windowMs * sampleRate / 2000));
  const smoothingSamples = Math.max(1, Math.floor(1 * sampleRate / 1000));

  // Convert threshold from dB to linear (squared for comparison with RMS²)
  const thresholdLinear = Math.pow(10, thresholdDb / 20);
  const thresholdSq = thresholdLinear * thresholdLinear;

  // Pass 1: compute sum of squares
  const sumSq = computeSumSq(channelData);

  // Pass 2: sliding window RMS²
  const rmsSq = computeRmsSq(sumSq, halfWindow);

  // Pass 3: gate gain state machine
  const gateGain = computeGateGain(rmsSq, thresholdSq, attackSamples, holdSamples, releaseSamples);

  // Pass 4: smoothing
  const smoothedGain = smoothGateGain(gateGain, smoothingSamples);

  // Pass 5: apply to channels
  const outputData = applyGateToChannels(channelData, smoothedGain);

  // Transfer buffers back
  const transferList = outputData.map(arr => arr.buffer);
  self.postMessage({ outputData, taskId }, transferList);
}

/**
 * Handle multi-buffer noise gate with shared envelope
 * This ensures coherent gating across directivity buffers (front/bell)
 * to maintain stable imaging during blending.
 */
function handleMultiBuffer(data) {
  const { buffers, sampleRate, options, taskId } = data;
  // buffers = [{channels: Float32Array[]}, ...]

  const {
    thresholdDb = -48,
    attackMs = 5,
    holdMs = 100,
    releaseMs = 80,
    windowMs = 20,
  } = options;

  if (!buffers || buffers.length === 0) {
    self.postMessage({ type: 'resultMulti', taskId, buffers: [] });
    return;
  }

  // Find max length across ALL buffers to ensure envelope covers all samples
  let maxLength = 0;
  for (const buf of buffers) {
    for (const ch of buf.channels) {
      maxLength = Math.max(maxLength, ch.length);
    }
  }
  const length = maxLength;

  // Convert times to samples
  const attackSamples = Math.max(1, Math.floor(attackMs * sampleRate / 1000));
  const holdSamples = Math.max(1, Math.floor(holdMs * sampleRate / 1000));
  const releaseSamples = Math.max(1, Math.floor(releaseMs * sampleRate / 1000));
  const halfWindow = Math.max(1, Math.floor(windowMs * sampleRate / 2000));
  const smoothingSamples = Math.max(1, Math.floor(1 * sampleRate / 1000));

  // Convert threshold from dB to linear (squared for comparison with RMS²)
  const thresholdLinear = Math.pow(10, thresholdDb / 20);
  const thresholdSq = thresholdLinear * thresholdLinear;

  // Pass 1: Compute UNIFIED sum of squares from ALL buffers combined
  // This ensures front and bell contribute equally to the envelope
  const unifiedSumSq = new Float32Array(length);
  let totalChannels = 0;

  for (const buf of buffers) {
    const numChannels = buf.channels.length;
    totalChannels += numChannels;
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = buf.channels[ch];
      const chLength = channelData.length;
      for (let i = 0; i < length; i++) {
        // Guard against shorter buffers - treat missing samples as silence
        const sample = i < chLength ? channelData[i] : 0;
        unifiedSumSq[i] += sample * sample;
      }
    }
  }

  // Normalize by total channel count across all buffers
  const invTotalChannels = 1 / totalChannels;
  for (let i = 0; i < length; i++) {
    unifiedSumSq[i] *= invTotalChannels;
  }

  // Pass 2: sliding window RMS² from unified sum
  const rmsSq = computeRmsSq(unifiedSumSq, halfWindow);

  // Pass 3: single gate gain state machine
  const gateGain = computeGateGain(rmsSq, thresholdSq, attackSamples, holdSamples, releaseSamples);

  // Pass 4: smoothing
  const smoothedGain = smoothGateGain(gateGain, smoothingSamples);

  // Pass 5: Apply SAME smoothedGain to EACH buffer independently
  const processedBuffers = [];
  const allTransfers = [];

  for (const buf of buffers) {
    const outputChannels = applyGateToChannels(buf.channels, smoothedGain);
    processedBuffers.push({ channels: outputChannels });
    for (const ch of outputChannels) {
      allTransfers.push(ch.buffer);
    }
  }

  // Transfer all buffers back
  self.postMessage({ type: 'resultMulti', taskId, buffers: processedBuffers }, allTransfers);
}
