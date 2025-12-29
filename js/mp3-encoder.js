// MP3 file encoder using lamejs

/**
 * Convert an AudioBuffer to MP3
 * @param {AudioBuffer} audioBuffer - Audio buffer to convert
 * @param {number} bitRate - Bitrate in kbps (default 192)
 * @param {Function} onProgress - Progress callback (0-1)
 * @returns {Promise<Blob>} - MP3 blob
 */
export async function audioBufferToMp3(audioBuffer, bitRate = 192, onProgress) {
  return new Promise((resolve, reject) => {
    try {
      const numChannels = audioBuffer.numberOfChannels;
      const sampleRate = audioBuffer.sampleRate;

      // Get channel data
      const leftChannel = audioBuffer.getChannelData(0);
      const rightChannel = numChannels > 1 ? audioBuffer.getChannelData(1) : leftChannel;

      // Create encoder
      const mp3Encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitRate);

      const mp3Data = [];
      const sampleBlockSize = 1152; // Must be multiple of 576

      // Convert Float32 to Int16
      const leftInt16 = floatTo16BitPCM(leftChannel);
      const rightInt16 = numChannels > 1 ? floatTo16BitPCM(rightChannel) : leftInt16;

      const totalSamples = leftInt16.length;
      let processedSamples = 0;

      // Process in chunks to avoid blocking UI
      const processChunk = () => {
        const chunkSize = 10; // Number of blocks per chunk

        for (let i = 0; i < chunkSize && processedSamples < totalSamples; i++) {
          const start = processedSamples;
          const end = Math.min(start + sampleBlockSize, totalSamples);

          const leftChunk = leftInt16.subarray(start, end);
          const rightChunk = rightInt16.subarray(start, end);

          let mp3buf;
          if (numChannels === 1) {
            mp3buf = mp3Encoder.encodeBuffer(leftChunk);
          } else {
            mp3buf = mp3Encoder.encodeBuffer(leftChunk, rightChunk);
          }

          if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
          }

          processedSamples = end;
        }

        if (onProgress) {
          onProgress(processedSamples / totalSamples);
        }

        if (processedSamples < totalSamples) {
          // Continue processing
          setTimeout(processChunk, 0);
        } else {
          // Finish encoding
          const mp3buf = mp3Encoder.flush();
          if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
          }

          // Create blob
          const blob = new Blob(mp3Data, { type: 'audio/mp3' });
          resolve(blob);
        }
      };

      // Start processing
      setTimeout(processChunk, 0);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Convert Float32 samples to Int16
 * @param {Float32Array} floatSamples - Float32 samples
 * @returns {Int16Array} - Int16 samples
 */
function floatTo16BitPCM(floatSamples) {
  const int16 = new Int16Array(floatSamples.length);

  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  return int16;
}

/**
 * Check if lamejs is available
 * @returns {boolean} - Whether lamejs is loaded
 */
export function isLameJsAvailable() {
  return typeof lamejs !== 'undefined';
}
