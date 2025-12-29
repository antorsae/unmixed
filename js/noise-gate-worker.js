// Noise Gate Web Worker - runs heavy processing off main thread

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
  const attackSamples = Math.floor(attackMs * sampleRate / 1000);
  const holdSamples = Math.floor(holdMs * sampleRate / 1000);
  const releaseSamples = Math.floor(releaseMs * sampleRate / 1000);
  const windowSamples = Math.floor(windowMs * sampleRate / 1000);

  // Convert threshold from dB to linear
  const threshold = Math.pow(10, thresholdDb / 20);

  // First pass: compute RMS envelope across all channels
  const envelope = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const data = channelData[ch];
    for (let i = 0; i < length; i++) {
      envelope[i] += data[i] * data[i];
    }
  }

  // Normalize by number of channels
  for (let i = 0; i < length; i++) {
    envelope[i] = Math.sqrt(envelope[i] / numChannels);
  }

  // Compute RMS in sliding window
  const rmsEnvelope = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const windowStart = Math.max(0, i - Math.floor(windowSamples / 2));
    const windowEnd = Math.min(length, i + Math.floor(windowSamples / 2));
    const windowLen = windowEnd - windowStart;

    let sum = 0;
    for (let j = windowStart; j < windowEnd; j++) {
      sum += envelope[j] * envelope[j];
    }
    rmsEnvelope[i] = Math.sqrt(sum / windowLen);
  }

  // Second pass: compute gate gain envelope
  const gateGain = new Float32Array(length);
  let gateState = 0;
  let stateCounter = 0;
  let currentGain = 0;

  for (let i = 0; i < length; i++) {
    const level = rmsEnvelope[i];
    const aboveThreshold = level > threshold;

    switch (gateState) {
      case 0: // Closed
        if (aboveThreshold) {
          gateState = 1;
          stateCounter = 0;
        }
        currentGain = 0;
        break;

      case 1: // Opening (attack)
        stateCounter++;
        currentGain = Math.min(1, stateCounter / attackSamples);
        if (stateCounter >= attackSamples) {
          gateState = 2;
        }
        break;

      case 2: // Open
        currentGain = 1;
        if (!aboveThreshold) {
          gateState = 3;
          stateCounter = 0;
        }
        break;

      case 3: // Holding
        currentGain = 1;
        stateCounter++;
        if (aboveThreshold) {
          gateState = 2;
        } else if (stateCounter >= holdSamples) {
          gateState = 4;
          stateCounter = 0;
        }
        break;

      case 4: // Closing (release)
        stateCounter++;
        currentGain = Math.max(0, 1 - stateCounter / releaseSamples);
        if (aboveThreshold) {
          gateState = 1;
          stateCounter = Math.floor((1 - currentGain) * attackSamples);
        } else if (stateCounter >= releaseSamples) {
          gateState = 0;
          currentGain = 0;
        }
        break;
    }

    gateGain[i] = currentGain;
  }

  // Apply smoothing to gate gain
  const smoothedGain = new Float32Array(length);
  const smoothingSamples = Math.floor(2 * sampleRate / 1000);

  for (let i = 0; i < length; i++) {
    let sum = 0;
    let count = 0;
    const start = Math.max(0, i - smoothingSamples);
    const end = Math.min(length - 1, i + smoothingSamples);
    for (let j = start; j <= end; j++) {
      sum += gateGain[j];
      count++;
    }
    smoothedGain[i] = sum / count;
  }

  // Third pass: apply gate to all channels
  const outputData = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const input = channelData[ch];
    const output = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      output[i] = input[i] * smoothedGain[i];
    }
    outputData.push(output);
  }

  // Transfer buffers back (more efficient)
  const transferList = outputData.map(arr => arr.buffer);

  self.postMessage({ outputData, taskId }, transferList);
};
