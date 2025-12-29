// Noise Gate Web Worker - Optimized O(n) algorithm
// Uses sliding window for RMS and smoothing to avoid O(n*window) complexity

self.onmessage = function(e) {
  const { channelData, sampleRate, options, taskId } = e.data;

  const {
    thresholdDb = -48,
    attackMs = 2,
    holdMs = 30,
    releaseMs = 50,
    windowMs = 10,
  } = options;

  const numChannels = channelData.length;
  const length = channelData[0].length;

  // Convert times to samples
  const attackSamples = Math.max(1, Math.floor(attackMs * sampleRate / 1000));
  const holdSamples = Math.max(1, Math.floor(holdMs * sampleRate / 1000));
  const releaseSamples = Math.max(1, Math.floor(releaseMs * sampleRate / 1000));
  const halfWindow = Math.max(1, Math.floor(windowMs * sampleRate / 2000));

  // Convert threshold from dB to linear (squared for comparison with RMS²)
  const thresholdLinear = Math.pow(10, thresholdDb / 20);
  const thresholdSq = thresholdLinear * thresholdLinear;

  // First pass: compute sum of squares across all channels
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

  // Second pass: O(n) sliding window RMS² (we compare squared values to avoid sqrt)
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

  // Third pass: compute gate gain with state machine
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

  // Fourth pass: O(n) sliding window smoothing (2ms)
  const smoothingSamples = Math.max(1, Math.floor(2 * sampleRate / 1000));
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

  // Fifth pass: apply gate to all channels
  const outputData = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const input = channelData[ch];
    const output = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      output[i] = input[i] * smoothedGain[i];
    }
    outputData.push(output);
  }

  // Transfer buffers back
  const transferList = outputData.map(arr => arr.buffer);
  self.postMessage({ outputData, taskId }, transferList);
};
