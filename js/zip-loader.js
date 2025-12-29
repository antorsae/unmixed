// ZIP file loading and extraction

// Multiple CORS proxies to try in order
const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

/**
 * Fetch with progress tracking
 */
async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    loaded += value.length;

    if (onProgress && total > 0) {
      onProgress(loaded / total);
    }
  }

  const blob = new Blob(chunks);
  return blob.arrayBuffer();
}

/**
 * Load a ZIP file from a URL
 * @param {string} url - ZIP file URL
 * @param {Function} onProgress - Progress callback (0-1)
 * @param {boolean} useCorsProxy - Whether to use CORS proxy
 * @returns {Promise<JSZip>} - Loaded ZIP object
 */
export async function loadZipFromUrl(url, onProgress, useCorsProxy = false) {
  let arrayBuffer;
  let lastError;

  if (!useCorsProxy) {
    // Try direct fetch first
    try {
      arrayBuffer = await fetchWithProgress(url, onProgress);
    } catch (error) {
      throw error;
    }
  } else {
    // Try each CORS proxy until one works
    for (let i = 0; i < CORS_PROXIES.length; i++) {
      const proxyUrl = CORS_PROXIES[i](url);
      console.log(`[ZIP Loader] Trying CORS proxy ${i + 1}/${CORS_PROXIES.length}...`);

      try {
        arrayBuffer = await fetchWithProgress(proxyUrl, onProgress);
        console.log(`[ZIP Loader] CORS proxy ${i + 1} succeeded`);
        break;
      } catch (error) {
        console.warn(`[ZIP Loader] CORS proxy ${i + 1} failed:`, error.message);
        lastError = error;
      }
    }

    if (!arrayBuffer) {
      throw new Error(`All CORS proxies failed. Last error: ${lastError?.message}. Please download the ZIP manually and upload it.`);
    }
  }

  // Load as ZIP
  const zip = await JSZip.loadAsync(arrayBuffer);
  return zip;
}

/**
 * Load a ZIP file from a File object
 * @param {File} file - ZIP file
 * @param {Function} onProgress - Progress callback (0-1)
 * @returns {Promise<JSZip>} - Loaded ZIP object
 */
export async function loadZipFromFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded / e.total);
      }
    };

    reader.onload = async () => {
      try {
        const zip = await JSZip.loadAsync(reader.result);
        resolve(zip);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => reject(reader.error);

    reader.readAsArrayBuffer(file);
  });
}

/**
 * Extract audio files from a ZIP
 * @param {JSZip} zip - ZIP object
 * @param {Function} onFileExtracted - Callback for each extracted file (filename, arrayBuffer)
 * @param {Function} onProgress - Progress callback (0-1)
 * @returns {Promise<Array>} - Array of { filename, arrayBuffer }
 */
export async function extractAudioFiles(zip, onFileExtracted, onProgress) {
  const audioExtensions = /\.(mp3|wav|flac|ogg|aac|m4a|webm)$/i;
  const audioFiles = [];

  // Get all audio files
  const entries = [];
  zip.forEach((relativePath, file) => {
    if (!file.dir && audioExtensions.test(relativePath)) {
      entries.push({ path: relativePath, file });
    }
  });

  const total = entries.length;

  for (let i = 0; i < entries.length; i++) {
    const { path, file } = entries[i];

    try {
      const arrayBuffer = await file.async('arraybuffer');
      const result = { filename: path, arrayBuffer };

      audioFiles.push(result);

      if (onFileExtracted) {
        await onFileExtracted(result);
      }
    } catch (error) {
      console.error(`Failed to extract ${path}:`, error);
    }

    if (onProgress) {
      onProgress((i + 1) / total);
    }
  }

  return audioFiles;
}

/**
 * Check if a URL is likely to have CORS issues
 * @param {string} url - URL to check
 * @returns {boolean} - Whether CORS proxy might be needed
 */
export function mightNeedCorsProxy(url) {
  try {
    const urlObj = new URL(url);
    const currentOrigin = window.location.origin;

    // Same origin is fine
    if (urlObj.origin === currentOrigin) {
      return false;
    }

    // localhost is usually fine
    if (urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1') {
      return false;
    }

    // Known CORS-friendly origins
    const corsFreindly = [
      'github.com',
      'githubusercontent.com',
      'cloudflare.com',
    ];

    if (corsFreindly.some(domain => urlObj.hostname.includes(domain))) {
      return false;
    }

    // Probably needs proxy
    return true;
  } catch {
    return true;
  }
}

/**
 * Load audio files from a FileList
 * @param {FileList} files - Files to load
 * @param {Function} onFileLoaded - Callback for each loaded file
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Array>} - Array of { filename, arrayBuffer }
 */
export async function loadAudioFiles(files, onFileLoaded, onProgress) {
  const audioFiles = [];
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = { filename: file.name, arrayBuffer };

      audioFiles.push(result);

      if (onFileLoaded) {
        await onFileLoaded(result);
      }
    } catch (error) {
      console.error(`Failed to load ${file.name}:`, error);
    }

    if (onProgress) {
      onProgress((i + 1) / total);
    }
  }

  return audioFiles;
}
