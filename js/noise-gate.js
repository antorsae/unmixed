// Noise Gate - Buffer pre-processing for removing background noise
// Processing is done in noise-gate-worker.js for non-blocking operation

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
 * Default noise gate options
 */
export const DEFAULT_NOISE_GATE_OPTIONS = {
  thresholdDb: -48,
  attackMs: 5,
  holdMs: 100,
  releaseMs: 80,
  windowMs: 20,
};
