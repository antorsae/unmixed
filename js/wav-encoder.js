// WAV file encoder

/**
 * Convert an AudioBuffer to a WAV file ArrayBuffer
 * @param {AudioBuffer} audioBuffer - Audio buffer to convert
 * @returns {ArrayBuffer} - WAV file data
 */
export function audioBufferToWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitsPerSample = 16;

  // Get channel data
  const channels = [];
  for (let i = 0; i < numChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  // Interleave channels
  const length = channels[0].length;
  const interleaved = new Float32Array(length * numChannels);

  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      interleaved[i * numChannels + c] = channels[c][i];
    }
  }

  // Convert to 16-bit PCM
  const dataLength = interleaved.length * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // Write WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true); // ByteRate
  view.setUint16(32, numChannels * (bitsPerSample / 8), true); // BlockAlign
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Write audio data
  floatTo16BitPCM(view, 44, interleaved);

  return buffer;
}

/**
 * Write a string to a DataView
 * @param {DataView} view - DataView to write to
 * @param {number} offset - Byte offset
 * @param {string} string - String to write
 */
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Convert Float32 samples to 16-bit PCM
 * @param {DataView} view - DataView to write to
 * @param {number} offset - Byte offset
 * @param {Float32Array} input - Float32 samples
 */
function floatTo16BitPCM(view, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}

/**
 * Create a downloadable Blob from an ArrayBuffer
 * @param {ArrayBuffer} arrayBuffer - WAV data
 * @returns {Blob} - Downloadable blob
 */
export function createWavBlob(arrayBuffer) {
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/**
 * Trigger a file download
 * @param {Blob} blob - File blob
 * @param {string} filename - Filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Generate a filename with timestamp
 * @param {string} profile - Profile name
 * @param {string} extension - File extension
 * @returns {string} - Filename
 */
export function generateFilename(profile, extension) {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\..+/, '');

  const profileName = profile || 'custom';

  return `${profileName}-mix-${timestamp}.${extension}`;
}
