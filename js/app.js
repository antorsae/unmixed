// Main application entry point

import { PROFILES, FAMILY_ORDER, FAMILY_COLORS } from './positions.js';
import { parseTrackFilename, generateTrackId, sortTracksByFamily } from './track-parser.js';
import { AudioEngine, STEREO_TECHNIQUES, POLAR_PATTERNS, createMicrophoneConfig } from './audio-engine.js';
import { StageCanvas } from './stage-canvas.js?v=4';
import { loadZipFromUrl, loadZipFromFile, extractAudioFiles, loadAudioFiles, mightNeedCorsProxy } from './zip-loader.js?v=3';
import { audioBufferToWav, createWavBlob, downloadBlob, generateFilename } from './wav-encoder.js';
import { audioBufferToMp3, isLameJsAvailable } from './mp3-encoder.js';
import { ReverbManager } from './reverb.js';
import { saveSession, loadSession, clearSession, hasSession, createSessionState, applySessionToTracks, setupUnloadWarning, debounce } from './persistence.js';
import { copyAudioBuffer, DEFAULT_NOISE_GATE_OPTIONS } from './noise-gate.js';

// Application state
const state = {
  tracks: new Map(), // trackId -> full track data
  currentProfile: null,
  currentProfileName: null,
  masterGainDb: 0,
  masterGainAuto: true,
  reverbPreset: 'none',
  reverbMode: 'depth',
  reverbWetDb: 0,
  groundReflectionEnabled: false,
  groundReflectionModel: 'stage',
  micSeparation: 2, // meters (legacy, now derived from micConfig)
  micConfig: createMicrophoneConfig('spaced-pair'), // Full microphone configuration
  showPolarPatterns: true,
  noiseGateEnabled: false,
  noiseGateThreshold: DEFAULT_NOISE_GATE_OPTIONS.thresholdDb,
  isLoading: false,
  hasUnsavedChanges: false,
};

// Core components
let audioEngine = null;
let stageCanvas = null;
let reverbManager = null;
let isTrackDragActive = false;
let masterMeterFrameId = null;
let masterMeterSmoothedDb = null;
let autoGainController = null;
let autoGainTimer = null;
let autoGainRequestId = 0;

// Noise gate worker
let noiseGateWorker = null;
let noiseGateTaskId = 0;
const noiseGatePendingTasks = new Map();
let noiseGateGeneration = 0; // For serializing async reprocessing

// Render state
let renderAbortController = null;

// Debounced save function (created once, reused)
let debouncedSaveSession = null;

// Pending shared config (for URL sharing and CORS fallback)
let pendingSharedConfig = null;

// DOM elements
const elements = {};

const NOISE_FLOOR_ANALYSIS = {
  windowMs: 50,
  percentile: 0.1,
  maxWindows: 1000,
  minDb: -120,
};

const MASTER_GAIN_DB_MIN = -36;
const MASTER_GAIN_DB_MAX = 30;
const MASTER_TARGET_RMS_DB = -18;
const MASTER_PEAK_LIMIT_DB = -1;
const MASTER_METER_RANGE_DB = 12;
const MASTER_ANALYSIS_SAMPLE_RATE = 22050;
const MASTER_ANALYSIS_WINDOW_MS = 200;
const MASTER_ANALYSIS_PERCENTILE = 0.95;
const MASTER_ANALYSIS_MIN_DB = -80;
const MASTER_AUTO_DEBOUNCE_MS = 800;

// Wikipedia links for microphone techniques
const TECHNIQUE_WIKI = {
  'spaced-pair': 'https://en.wikipedia.org/wiki/Microphone_practice#A-B_stereo',
  'xy-coincident': 'https://en.wikipedia.org/wiki/Microphone_practice#X-Y_technique',
  'ortf': 'https://en.wikipedia.org/wiki/ORTF_stereo_technique',
  'blumlein': 'https://en.wikipedia.org/wiki/Blumlein_pair',
  'decca-tree': 'https://en.wikipedia.org/wiki/Decca_tree',
};

/**
 * Initialize the application
 */
async function init() {
  // Cache DOM elements
  cacheElements();

  // Check for mobile
  checkMobile();

  // Initialize audio engine
  audioEngine = new AudioEngine();
  await audioEngine.init();

  // Initialize reverb manager
  reverbManager = new ReverbManager(audioEngine.context);

  // Initialize noise gate worker
  initNoiseGateWorker();

  // Initialize stage canvas
  stageCanvas = new StageCanvas(elements.stageCanvas);
  setupStageCallbacks();
  stageCanvas.setAudioEngine(audioEngine);  // For real-time level animation

  // Set up event listeners
  setupEventListeners();

  // Set up keyboard shortcuts
  setupKeyboardShortcuts();

  // Set up auto-save (create debounced function once)
  debouncedSaveSession = debounce(() => {
    if (state.tracks.size > 0) {
      saveCurrentSession();
    }
  }, 1000);

  // Set up unsaved changes warning
  setupUnloadWarning(() => state.hasUnsavedChanges);

  // Check for shared config in URL (takes priority over saved session)
  const hasSharedURL = location.hash.startsWith('#c=');
  if (hasSharedURL) {
    loadFromURL(); // Shows confirmation modal
  } else if (hasSession()) {
    // Only show restore modal if no shared URL
    showRestoreModal();
  }

  // Set initial reverb
  updateReverb();

  // Update UI
  updateTransportUI();
  updateMicControlsUI();
  if (elements.groundReflectionModel) {
    elements.groundReflectionModel.value = state.groundReflectionEnabled
      ? state.groundReflectionModel
      : 'none';
  }
}

/**
 * Cache DOM elements
 */
function cacheElements() {
  elements.header = document.getElementById('header');
  elements.profileName = document.getElementById('profile-name');
  elements.profilePanel = document.getElementById('profile-panel');
  elements.loadProfileBtn = document.getElementById('load-profile-btn');
  elements.loadProgress = document.getElementById('load-progress');
  elements.progressFill = elements.loadProgress?.querySelector('.progress-fill');
  elements.progressText = elements.loadProgress?.querySelector('.progress-text');
  elements.uploadZipBtn = document.getElementById('upload-zip-btn');
  elements.zipInput = document.getElementById('zip-input');
  elements.browseFilesBtn = document.getElementById('browse-files-btn');
  elements.filesInput = document.getElementById('files-input');
  elements.dropZone = document.getElementById('drop-zone');
  elements.statusText = document.getElementById('status-text');
  elements.stageCanvas = document.getElementById('stage-canvas');
  elements.trackList = document.getElementById('track-list');
  elements.playBtn = document.getElementById('play-btn');
  elements.stopBtn = document.getElementById('stop-btn');
  elements.rewindBtn = document.getElementById('rewind-btn');
  elements.seekBar = document.getElementById('seek-bar');
  elements.timeDisplay = document.getElementById('time-display');
  elements.masterGain = document.getElementById('master-gain');
  elements.masterGainValue = document.getElementById('master-gain-value');
  elements.masterAuto = document.getElementById('master-auto');
  elements.masterAutoTarget = document.getElementById('master-auto-target');
  elements.masterMeterText = document.getElementById('master-meter-text');
  elements.masterMeterFill = document.getElementById('master-meter-fill');
  elements.masterAutoStatus = document.getElementById('master-auto-status');
  elements.reverbPreset = document.getElementById('reverb-preset');
  elements.reverbMode = document.getElementById('reverb-mode');
  elements.reverbWet = document.getElementById('reverb-wet');
  elements.reverbWetValue = document.getElementById('reverb-wet-value');
  elements.reverbWetControl = document.querySelector('.reverb-wet-control');
  elements.groundReflectionModel = document.getElementById('ground-reflection-model');
  // Microphone controls
  elements.micTechnique = document.getElementById('mic-technique');
  elements.micTechniqueWiki = document.getElementById('mic-technique-wiki');
  elements.micPattern = document.getElementById('mic-pattern');
  elements.micSpacing = document.getElementById('mic-spacing');
  elements.micSpacingValue = document.getElementById('mic-spacing-value');
  elements.micAngle = document.getElementById('mic-angle');
  elements.micAngleValue = document.getElementById('mic-angle-value');
  elements.micAngleControl = document.querySelector('.mic-angle-control');
  elements.micSpacingControl = document.querySelector('.mic-spacing-control');
  elements.micCenterControls = document.querySelector('.mic-center-controls');
  elements.micCenterDepth = document.getElementById('mic-center-depth');
  elements.micCenterDepthValue = document.getElementById('mic-center-depth-value');
  elements.micCenterLevel = document.getElementById('mic-center-level');
  elements.micCenterLevelValue = document.getElementById('mic-center-level-value');
  // Legacy (for compatibility)
  elements.micSeparation = elements.micSpacing;
  elements.micSeparationValue = elements.micSpacingValue;
  elements.resetPositionsBtn = document.getElementById('reset-positions-btn');
  elements.resetAllBtn = document.getElementById('reset-all-btn');
  elements.shareBtn = document.getElementById('share-btn');
  elements.downloadWavBtn = document.getElementById('download-wav-btn');
  elements.downloadMp3Btn = document.getElementById('download-mp3-btn');
  elements.toastContainer = document.getElementById('toast-container');
  elements.trackListSection = document.getElementById('track-list-section');
  elements.trackListHeader = document.getElementById('track-list-header');
  elements.trackCount = document.getElementById('track-count');
  elements.renderModal = document.getElementById('render-modal');
  elements.renderProgressFill = document.getElementById('render-progress-fill');
  elements.renderProgressText = document.getElementById('render-progress-text');
  elements.cancelRenderBtn = document.getElementById('cancel-render-btn');
  elements.restoreModal = document.getElementById('restore-modal');
  elements.restoreYesBtn = document.getElementById('restore-yes-btn');
  elements.restoreNoBtn = document.getElementById('restore-no-btn');
  elements.shareModal = document.getElementById('share-modal');
  elements.shareModalDetails = document.getElementById('share-modal-details');
  elements.shareLoadBtn = document.getElementById('share-load-btn');
  elements.shareCancelBtn = document.getElementById('share-cancel-btn');
  elements.mobileWarning = document.getElementById('mobile-warning');
  elements.dismissMobileWarning = document.getElementById('dismiss-mobile-warning');
  elements.noiseGateCheckbox = document.getElementById('noise-gate-checkbox');
  elements.noiseGateThreshold = document.getElementById('noise-gate-threshold');
  elements.noiseGateThresholdValue = document.getElementById('noise-gate-threshold-value');
  elements.noiseGateThresholdContainer = document.getElementById('noise-gate-threshold-container');
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
  // Profile loading
  elements.loadProfileBtn.addEventListener('click', loadSelectedProfile);
  elements.uploadZipBtn.addEventListener('click', () => elements.zipInput.click());
  elements.zipInput.addEventListener('change', handleZipUpload);
  elements.browseFilesBtn.addEventListener('click', () => elements.filesInput.click());
  elements.filesInput.addEventListener('change', handleFilesUpload);

  // Drag and drop
  elements.dropZone.addEventListener('dragover', handleDragOver);
  elements.dropZone.addEventListener('dragleave', handleDragLeave);
  elements.dropZone.addEventListener('drop', handleDrop);

  // Transport controls
  elements.playBtn.addEventListener('click', togglePlayback);
  elements.stopBtn.addEventListener('click', stopPlayback);
  elements.rewindBtn.addEventListener('click', rewind);
  elements.seekBar.addEventListener('input', handleSeek);

  // Master controls
  elements.masterGain.addEventListener('input', handleMasterGainChange);
  elements.masterAuto?.addEventListener('change', handleMasterAutoToggle);

  // Reverb controls
  elements.reverbPreset.addEventListener('change', handleReverbPresetChange);
  elements.reverbMode?.addEventListener('change', handleReverbModeChange);
  elements.reverbWet.addEventListener('input', handleReverbWetChange);

  // Physics controls
  elements.groundReflectionModel?.addEventListener('change', handleGroundReflectionModelChange);

  // Microphone controls
  elements.micTechnique?.addEventListener('change', handleMicTechniqueChange);
  elements.micPattern?.addEventListener('change', handleMicPatternChange);
  elements.micSpacing?.addEventListener('input', handleMicSpacingChange);
  elements.micAngle?.addEventListener('input', handleMicAngleChange);
  elements.micCenterDepth?.addEventListener('input', handleMicCenterDepthChange);
  elements.micCenterLevel?.addEventListener('input', handleMicCenterLevelChange);

  // Noise gate controls
  elements.noiseGateCheckbox.addEventListener('change', handleNoiseGateToggle);
  elements.noiseGateThreshold.addEventListener('input', handleNoiseGateThresholdChange);

  // Track list toggle
  elements.trackListHeader.addEventListener('click', toggleTrackList);

  // Reset buttons
  elements.resetPositionsBtn.addEventListener('click', resetPositions);
  elements.resetAllBtn.addEventListener('click', resetAll);

  // Share and download buttons
  elements.shareBtn?.addEventListener('click', shareConfig);
  elements.downloadWavBtn.addEventListener('click', downloadWav);
  elements.downloadMp3Btn.addEventListener('click', downloadMp3);
  elements.cancelRenderBtn.addEventListener('click', cancelRender);

  // Restore modal
  elements.restoreYesBtn.addEventListener('click', restoreSession);
  elements.restoreNoBtn.addEventListener('click', () => {
    clearSession();
    hideRestoreModal();
  });

  // Share modal
  elements.shareLoadBtn?.addEventListener('click', confirmSharedConfig);
  elements.shareCancelBtn?.addEventListener('click', cancelSharedConfig);

  // Mobile warning
  elements.dismissMobileWarning?.addEventListener('click', () => {
    elements.mobileWarning.classList.add('hidden');
  });

  // Audio engine callbacks
  audioEngine.onTimeUpdate = updateTimeDisplay;
  audioEngine.onPlaybackEnd = handlePlaybackEnd;
}

/**
 * Set up stage canvas callbacks
 */
function setupStageCallbacks() {
  stageCanvas.onTrackMove = (trackId, x, y) => {
    const track = state.tracks.get(trackId);
    if (track) {
      track.x = x;
      track.y = y;
      if (!isTrackDragActive) {
        audioEngine.updateTrackPosition(trackId, x, y);
      }
      updateTrackListItem(trackId);
      markUnsaved();
    }
  };

  stageCanvas.onTrackMoveStart = (trackId) => {
    isTrackDragActive = true;
  };

  stageCanvas.onTrackMoveEnd = (trackId, x, y) => {
    const track = state.tracks.get(trackId);
    isTrackDragActive = false;
    if (track) {
      track.x = x;
      track.y = y;
      audioEngine.updateTrackPosition(trackId, x, y);
      audioEngine.scheduleGraphRebuild({ delayMs: 0 });
      updateTrackListItem(trackId);
      markUnsaved();
      maybeScheduleAutoMasterGainUpdate();
    }
  };

  stageCanvas.onTrackSelect = (trackId, multi) => {
    selectTrack(trackId, multi);
  };

  stageCanvas.onTrackDeselect = (trackId) => {
    deselectAllTracks();
  };

  stageCanvas.onTrackDoubleClick = (trackId) => {
    resetTrackPosition(trackId);
  };

  stageCanvas.onTrackWheel = (trackId, delta) => {
    const track = state.tracks.get(trackId);
    if (track) {
      const newGain = Math.max(0, Math.min(2, track.gain + delta));
      track.gain = newGain;
      audioEngine.updateTrackGain(trackId, newGain);
      updateTrackListItem(trackId);
      markUnsaved();
      maybeScheduleAutoMasterGainUpdate();
    }
  };

  stageCanvas.onTrackGainChange = (trackId, newGain) => {
    const track = state.tracks.get(trackId);
    if (track) {
      track.gain = newGain;
      audioEngine.updateTrackGain(trackId, newGain);
      updateTrackListItem(trackId);
      markUnsaved();
      maybeScheduleAutoMasterGainUpdate();
    }
  };

  stageCanvas.onTrackMuteToggle = (trackId, muted) => {
    const track = state.tracks.get(trackId);
    if (track) {
      track.muted = muted;
      audioEngine.updateTrackMuted(trackId, muted);
      updateTrackListItem(trackId);
      markUnsaved();
      maybeScheduleAutoMasterGainUpdate();
    }
  };

  stageCanvas.onTrackSoloToggle = (trackId, solo) => {
    const track = state.tracks.get(trackId);
    if (track) {
      track.solo = solo;
      audioEngine.updateTrackSolo(trackId, solo);
      updateTrackListItem(trackId);
      markUnsaved();
      maybeScheduleAutoMasterGainUpdate();
    }
  };

  // Mic separation drag on canvas (legacy callback)
  stageCanvas.onMicSeparationChange = (separation) => {
    state.micSeparation = separation;
    state.micConfig.spacing = separation;
    if (elements.micSpacing) {
      elements.micSpacing.value = separation;
      elements.micSpacingValue.textContent = `${separation.toFixed(2)}m`;
    }
    audioEngine.setMicSeparation(separation);
    markUnsaved();
    maybeScheduleAutoMasterGainUpdate();
  };

  // Full mic config change callback (from canvas drag)
  stageCanvas.onMicConfigChange = (config) => {
    state.micConfig = config;
    state.micSeparation = config.spacing;
    updateMicControlsUI();
    audioEngine.setMicConfig(config);
    markUnsaved();
    maybeScheduleAutoMasterGainUpdate();
  };

  // Initialize canvas with mic config from state
  stageCanvas.setMicConfig(state.micConfig);
  stageCanvas.setShowPolarPatterns(true);
}

/**
 * Set up keyboard shortcuts
 */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ignore if focus is on an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
      return;
    }

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlayback();
        break;
      case 'KeyR':
        // Only rewind if no modifier keys (allow CMD+SHIFT+R for browser reload)
        if (!e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          rewind();
        }
        break;
    }
  });
}

/**
 * Check if on mobile device
 */
function checkMobile() {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  if (isMobile && elements.mobileWarning) {
    elements.mobileWarning.classList.remove('hidden');
  }
}

/**
 * Load the selected profile from Aalto
 */
async function loadSelectedProfile() {
  const selected = document.querySelector('input[name="profile"]:checked');
  if (!selected) return;

  const profileKey = selected.value;
  const profile = PROFILES[profileKey];

  if (!profile) return;

  await loadProfile(profileKey, profile.url, profile.fullName);
}

/**
 * Load a profile from URL
 */
async function loadProfile(profileKey, url, displayName) {
  if (state.isLoading) return;

  // Reset divider text in case previous load failed
  const divider = document.querySelector('#profile-upload-divider span');
  if (divider) divider.textContent = 'OR';

  // Stop current playback and clear tracks
  stopPlayback();
  clearTracks();
  pendingFiles = []; // Clear any stale pending files

  state.isLoading = true;
  state.currentProfile = profileKey;
  state.currentProfileName = displayName;

  showProgress('Downloading...');
  setStatus('Downloading profile...', 'info');

  try {
    // Use CORS proxy for external URLs
    let zip;
    const needsProxy = mightNeedCorsProxy(url);

    if (needsProxy) {
      setStatus('Downloading via proxy...', 'info');
    }

    zip = await loadZipFromUrl(url, updateProgress, needsProxy);

    // Extract audio files
    setStatus('Extracting audio files...', 'info');
    updateProgress(0);

    await extractAudioFiles(zip, async (file) => {
      await processAudioFile(file.filename, file.arrayBuffer);
    }, updateProgress);

    // Finalize
    await finalizeTracks();
    hideProgress();
    setStatus(`Loaded ${state.tracks.size} tracks`, 'success');
    updateProfileName();
    enableExportButtons();

  } catch (error) {
    console.error('Failed to load profile:', error);
    hideProgress();
    pendingFiles = []; // Clear pending files on error

    // Check if this is a CORS/download failure
    const isCorsError = error.message.includes('CORS') ||
                        error.message.includes('central directory') ||
                        error.message.includes('proxy') ||
                        error.message.includes('Failed to fetch');

    const profile = PROFILES[profileKey];
    if (isCorsError && profile?.url) {
      const filename = profile.url.split('/').pop();
      const msg = `Download failed. <button id="retry-download-btn" class="btn-link">Retry</button> or <a href="${profile.url}" target="_blank" rel="noopener">download ${filename}</a> manually, then upload below.`;
      setStatus(msg, 'error');
      showToast('Automatic download failed. See instructions above.', 'error');

      // Add retry handler
      const retryBtn = document.getElementById('retry-download-btn');
      if (retryBtn) {
        retryBtn.onclick = () => loadProfile(profileKey, url, displayName);
      }

      // Change "OR" to "AND" to guide user
      const divider = document.querySelector('#profile-upload-divider span');
      if (divider) divider.textContent = 'AND';
    } else {
      setStatus(error.message, 'error');
      showToast(error.message, 'error');
    }
  }

  state.isLoading = false;
}

/**
 * Handle ZIP file upload from input element
 */
async function handleZipUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  await handleZipFile(file);
  elements.zipInput.value = '';
}

/**
 * Handle ZIP file (from upload or drag/drop)
 */
async function handleZipFile(file) {
  if (state.isLoading) return;

  // Reset divider text in case previous download failed
  const divider = document.querySelector('#profile-upload-divider span');
  if (divider) divider.textContent = 'OR';

  stopPlayback();
  clearTracks();
  pendingFiles = []; // Clear any stale pending files

  state.isLoading = true;
  state.currentProfile = 'custom';
  state.currentProfileName = file.name.replace('.zip', '');

  showProgress('Loading ZIP...');
  setStatus('Loading ZIP file...', 'info');

  try {
    const zip = await loadZipFromFile(file, updateProgress);

    setStatus('Extracting audio files...', 'info');
    updateProgress(0);

    await extractAudioFiles(zip, async (f) => {
      await processAudioFile(f.filename, f.arrayBuffer);
    }, updateProgress);

    await finalizeTracks();
    hideProgress();
    setStatus(`Loaded ${state.tracks.size} tracks`, 'success');
    updateProfileName();
    enableExportButtons();

    // Apply pending shared config if CORS fallback was used
    if (pendingSharedConfig && state.tracks.size > 0) {
      applySharedConfig(pendingSharedConfig);
      showToast('Applied shared arrangement settings', 'success');
      pendingSharedConfig = null;
    }

  } catch (error) {
    console.error('Failed to load ZIP:', error);
    setStatus(error.message, 'error');
    showToast(error.message, 'error');
    hideProgress();
    pendingFiles = []; // Clear pending files on error
  }

  state.isLoading = false;
}

/**
 * Handle individual file uploads
 */
async function handleFilesUpload(e) {
  const files = e.target.files;
  if (!files.length) return;

  await loadFilesArray(files);
  elements.filesInput.value = '';
}

/**
 * Handle drag over
 */
function handleDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  elements.dropZone.classList.add('drag-over');
}

/**
 * Handle drag leave
 */
function handleDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  elements.dropZone.classList.remove('drag-over');
}

/**
 * Handle file drop
 */
async function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  elements.dropZone.classList.remove('drag-over');

  const files = e.dataTransfer.files;
  if (!files.length) return;

  // Check if it's a ZIP file
  if (files.length === 1 && files[0].name.endsWith('.zip')) {
    // Handle ZIP file directly (can't assign to input.files - it's read-only)
    await handleZipFile(files[0]);
  } else {
    await loadFilesArray(files);
  }
}

/**
 * Load an array of files
 */
async function loadFilesArray(files) {
  if (state.isLoading) return;

  stopPlayback();
  clearTracks();
  pendingFiles = []; // Clear any stale pending files

  state.isLoading = true;
  state.currentProfile = 'custom';
  state.currentProfileName = 'Custom Mix';

  showProgress('Loading files...');
  setStatus('Loading audio files...', 'info');

  try {
    await loadAudioFiles(files, async (file) => {
      await processAudioFile(file.filename, file.arrayBuffer);
    }, updateProgress);

    await finalizeTracks();
    hideProgress();
    setStatus(`Loaded ${state.tracks.size} tracks`, 'success');
    updateProfileName();
    enableExportButtons();

    // Apply pending shared config if CORS fallback was used
    if (pendingSharedConfig && state.tracks.size > 0) {
      applySharedConfig(pendingSharedConfig);
      showToast('Applied shared arrangement settings', 'success');
      pendingSharedConfig = null;
    }

  } catch (error) {
    console.error('Failed to load files:', error);
    setStatus(error.message, 'error');
    showToast(error.message, 'error');
    hideProgress();
    pendingFiles = []; // Clear pending files on error
  }

  state.isLoading = false;
}

// Temporary storage for decoded files before grouping
let pendingFiles = [];

/**
 * Process a single audio file (stores in pending, doesn't create track yet)
 */
async function processAudioFile(filename, arrayBuffer) {
  try {
    // Decode audio
    const audioBuffer = await audioEngine.decodeAudio(arrayBuffer);

    // Parse filename
    const parsed = parseTrackFilename(filename);

    // Store for later grouping
    pendingFiles.push({
      filename,
      audioBuffer,
      ...parsed,
    });

  } catch (error) {
    console.error(`Failed to decode ${filename}:`, error);
    showToast(`Failed to decode: ${filename}`, 'error');
  }
}

/**
 * Generate a unique key for grouping files by instrument (ignoring mic position)
 */
function getInstrumentKey(parsed) {
  // Key is baseName + instanceNumber (e.g., "corno1", "bsn", "vl1")
  const instance = parsed.instanceNumber ? parsed.instanceNumber : '';
  return `${parsed.baseName}${instance}`.toLowerCase();
}

/**
 * Group pending files by instrument and create tracks
 */
function createTracksFromPendingFiles() {
  // Group files by instrument
  const groups = new Map();

  for (const file of pendingFiles) {
    const key = getInstrumentKey(file);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(file);
  }

  // Create one track per instrument group
  for (const [key, files] of groups) {
    // Sort by mic position, prefer mic 6 as primary
    files.sort((a, b) => {
      // Mic 6 (front) should be first
      if (a.micPosition === '6') return -1;
      if (b.micPosition === '6') return 1;
      return (a.micPosition || '').localeCompare(b.micPosition || '');
    });

    const primary = files[0];
    const id = generateTrackId(primary.filename);

    // Build alternate buffers map (store originals only - noise gate applied later)
    const originalAlternateBuffers = new Map();
    for (const file of files) {
      const micPos = file.micPosition || '6';
      originalAlternateBuffers.set(micPos, file.audioBuffer);
    }

    // Store original buffer (noise gate applied later asynchronously)
    const originalBuffer = primary.audioBuffer;

    // Create track object with original (unprocessed) buffers
    const track = {
      id,
      filename: primary.filename,
      name: primary.displayName,
      family: primary.family,
      x: primary.defaultX,
      y: primary.defaultY,
      defaultX: primary.defaultX,
      defaultY: primary.defaultY,
      gain: 1,
      muted: false,
      solo: false,
      micPosition: primary.micPosition || '6',
      primaryMicPosition: primary.micPosition || '6', // For noise gate: which mic is the "main" buffer
      audioBuffer: originalBuffer, // Will be processed later if noise gate enabled
      originalBuffer: originalBuffer,
      alternateBuffers: originalAlternateBuffers.size > 1 ? new Map(originalAlternateBuffers) : null,
      originalAlternateBuffers: originalAlternateBuffers.size > 1 ? originalAlternateBuffers : null,
      availableMics: originalAlternateBuffers.size > 1 ? Array.from(originalAlternateBuffers.keys()) : null,
    };

    if (state.tracks.has(id)) {
      console.warn(`Track ID collision: ${id} - overwriting existing track`);
    }
    state.tracks.set(id, track);
  }

  // Clear pending files
  pendingFiles = [];
}

/**
 * Resolve overlapping track positions
 * Ensures no two tracks occupy the same position
 */
function resolveTrackOverlaps() {
  const minDistance = 0.08; // Minimum distance between track centers
  const tracks = Array.from(state.tracks.values());

  // Sort by family order, then by default position to maintain consistent ordering
  const familyOrder = ['strings', 'woodwinds', 'brass', 'percussion', 'keyboard', 'voice'];
  tracks.sort((a, b) => {
    const famA = familyOrder.indexOf(a.family);
    const famB = familyOrder.indexOf(b.family);
    if (famA !== famB) return famA - famB;
    if (a.defaultY !== b.defaultY) return a.defaultY - b.defaultY;
    return a.defaultX - b.defaultX;
  });

  // For each track, check if it overlaps with any previously placed track
  const placedTracks = [];

  for (const track of tracks) {
    let x = track.x;
    let y = track.y;
    let attempts = 0;
    const maxAttempts = 50;

    while (attempts < maxAttempts) {
      let hasOverlap = false;

      for (const placed of placedTracks) {
        const dx = x - placed.x;
        const dy = y - placed.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < minDistance) {
          hasOverlap = true;
          // Push away from the overlapping track
          if (dist < 0.001) {
            // Nearly identical position - push in a spiral pattern
            const angle = attempts * 0.5;
            const radius = minDistance * (1 + attempts * 0.1);
            x = track.defaultX + Math.cos(angle) * radius;
            y = track.defaultY + Math.sin(angle) * radius * 0.5;
          } else {
            // Push away along the line connecting them
            const pushX = (dx / dist) * (minDistance - dist + 0.01);
            const pushY = (dy / dist) * (minDistance - dist + 0.01);
            x += pushX;
            y += pushY;
          }
          // Clamp to valid range
          x = Math.max(-1, Math.min(1, x));
          y = Math.max(0, Math.min(1, y));
          break;
        }
      }

      if (!hasOverlap) break;
      attempts++;
    }

    track.x = x;
    track.y = y;
    track.defaultX = x;
    track.defaultY = y;
    placedTracks.push({ x, y });
  }
}

/**
 * Finalize tracks after loading
 */
async function finalizeTracks() {
  // First, group pending files and create tracks
  createTracksFromPendingFiles();

  // Apply instance spreading
  const tracksArray = Array.from(state.tracks.values());
  const parsedTracks = tracksArray.map(t => ({
    id: t.id,
    baseName: t.name.toLowerCase().replace(/\s+\d+$/, ''),
    instanceNumber: parseInt(t.name.match(/\d+$/)?.[0] || '0', 10),
    defaultX: t.defaultX,
  }));

  // Group and spread
  const groups = new Map();
  for (const pt of parsedTracks) {
    const key = pt.baseName;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pt);
  }

  for (const [, groupTracks] of groups) {
    if (groupTracks.length > 1) {
      groupTracks.sort((a, b) => a.instanceNumber - b.instanceNumber);
      const spread = 0.08;

      for (let i = 0; i < groupTracks.length; i++) {
        const offset = (i - (groupTracks.length - 1) / 2) * spread;
        const track = state.tracks.get(groupTracks[i].id);
        if (track) {
          track.defaultX = Math.max(-1, Math.min(1, track.defaultX + offset));
          track.x = track.defaultX;
        }
      }
    }
  }

  // Resolve any remaining overlaps
  resolveTrackOverlaps();

  // Analyze per-track noise floors before wiring audio graph
  await computeNoiseFloorsForTracks();

  // Add tracks to audio engine and stage
  for (const [id, track] of state.tracks) {
    audioEngine.addTrack(id, track.audioBuffer, {
      x: track.x,
      y: track.y,
      gain: track.gain,
      muted: track.muted,
      solo: track.solo,
      // Pass alternate buffers for directivity simulation
      directivityBuffers: track.alternateBuffers,
      noiseFloorDb: track.noiseFloorDb,
      noiseFloorByMic: track.noiseFloorByMic,
      primaryMicPosition: track.primaryMicPosition,
    });

    stageCanvas.addTrack(id, {
      x: track.x,
      y: track.y,
      name: track.name,
      family: track.family,
      gain: track.gain,
      muted: track.muted,
      solo: track.solo,
    });
  }

  // Calculate common prefix now that all tracks are added
  stageCanvas.refreshCommonPrefix();

  // Build track list UI
  buildTrackList();

  // Apply reverb
  updateReverb();

  // Apply noise gate asynchronously if enabled (runs in Web Worker)
  if (state.noiseGateEnabled) {
    applyNoiseGateToAllTracks();
  } else {
    maybeScheduleAutoMasterGainUpdate();
  }
}

/**
 * Clear all tracks
 */
function clearTracks() {
  audioEngine.clearTracks();
  stageCanvas.clearTracks();
  state.tracks.clear();
  elements.trackList.innerHTML = '';
  disableExportButtons();
  updateShareButtonState();
  if (autoGainTimer) {
    clearTimeout(autoGainTimer);
    autoGainTimer = null;
  }
  if (autoGainController) {
    autoGainController.abort();
    autoGainController = null;
  }
  setMasterAutoStatus('');
}

/**
 * Build the track list UI
 */
function buildTrackList() {
  const container = elements.trackList;
  container.innerHTML = '';

  // Sort tracks by family
  const sortedTracks = sortTracksByFamily(Array.from(state.tracks.values()));

  // Group by family
  const familyGroups = new Map();
  for (const track of sortedTracks) {
    if (!familyGroups.has(track.family)) {
      familyGroups.set(track.family, []);
    }
    familyGroups.get(track.family).push(track);
  }

  // Render each family group
  for (const family of FAMILY_ORDER) {
    if (!familyGroups.has(family)) continue;

    const tracks = familyGroups.get(family);

    const groupEl = document.createElement('div');
    groupEl.className = 'track-family-group';

    const headerEl = document.createElement('div');
    headerEl.className = `track-family-header ${family}`;
    headerEl.textContent = family.charAt(0).toUpperCase() + family.slice(1);
    groupEl.appendChild(headerEl);

    for (const track of tracks) {
      const itemEl = createTrackListItem(track);
      groupEl.appendChild(itemEl);
    }

    container.appendChild(groupEl);
  }

  // Update track count in header
  updateTrackCount();
}

/**
 * Create a track list item
 */
function createTrackListItem(track) {
  const el = document.createElement('div');
  el.className = 'track-item';
  el.dataset.trackId = track.id;

  // Show directivity indicator only if both mic 6 (front) AND mic 8 (bell) are available
  // Blending only occurs with this specific combination
  const hasDirectivity = track.availableMics &&
    track.availableMics.includes('6') &&
    track.availableMics.includes('8');

  const muteCheckbox = document.createElement('input');
  muteCheckbox.type = 'checkbox';
  muteCheckbox.className = 'track-mute';
  muteCheckbox.checked = !track.muted;
  muteCheckbox.title = 'Enable/Disable';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'track-name';
  nameSpan.style.color = FAMILY_COLORS[track.family];
  nameSpan.textContent = track.name;

  el.appendChild(muteCheckbox);
  el.appendChild(nameSpan);

  if (hasDirectivity) {
    const badge = document.createElement('span');
    badge.className = 'directivity-badge';
    badge.title = 'Directivity simulation active (blends front/bell mics based on position)';
    badge.textContent = 'DIR';
    el.appendChild(badge);
  }

  const controls = document.createElement('div');
  controls.className = 'track-controls';

  const xControl = document.createElement('div');
  xControl.className = 'track-control';
  const xLabel = document.createElement('label');
  xLabel.textContent = 'X:';
  const xSlider = document.createElement('input');
  xSlider.type = 'range';
  xSlider.className = 'track-x-slider';
  xSlider.min = '-1';
  xSlider.max = '1';
  xSlider.step = '0.01';
  xSlider.value = track.x;
  const xValue = document.createElement('input');
  xValue.type = 'text';
  xValue.className = 'value-input track-x-value';
  xValue.value = track.x.toFixed(2);
  xControl.append(xLabel, xSlider, xValue);

  const yControl = document.createElement('div');
  yControl.className = 'track-control';
  const yLabel = document.createElement('label');
  yLabel.textContent = 'Y:';
  const ySlider = document.createElement('input');
  ySlider.type = 'range';
  ySlider.className = 'track-y-slider';
  ySlider.min = '0';
  ySlider.max = '1';
  ySlider.step = '0.01';
  ySlider.value = track.y;
  const yValue = document.createElement('input');
  yValue.type = 'text';
  yValue.className = 'value-input track-y-value';
  yValue.value = track.y.toFixed(2);
  yControl.append(yLabel, ySlider, yValue);

  const gainControl = document.createElement('div');
  gainControl.className = 'track-control';
  const gainLabel = document.createElement('label');
  gainLabel.textContent = 'Gain:';
  const gainSlider = document.createElement('input');
  gainSlider.type = 'range';
  gainSlider.className = 'track-gain-slider';
  gainSlider.min = '0';
  gainSlider.max = '2';
  gainSlider.step = '0.01';
  gainSlider.value = track.gain;
  gainControl.append(gainLabel, gainSlider);

  const soloBtn = document.createElement('button');
  soloBtn.className = `track-solo ${track.solo ? 'active' : ''}`;
  soloBtn.textContent = 'S';

  controls.append(xControl, yControl, gainControl, soloBtn);
  el.appendChild(controls);

  // Event listeners
  muteCheckbox.addEventListener('change', () => {
    track.muted = !muteCheckbox.checked;
    audioEngine.updateTrackMuted(track.id, track.muted);
    stageCanvas.updateTrackMuted(track.id, track.muted);
    markUnsaved();
    maybeScheduleAutoMasterGainUpdate();
  });

  xSlider.addEventListener('input', () => {
    const x = parseFloat(xSlider.value);
    track.x = x;
    xValue.value = x.toFixed(2);
    audioEngine.updateTrackPosition(track.id, x, track.y);
    stageCanvas.updateTrackPosition(track.id, x, track.y);
    markUnsaved();
    maybeScheduleAutoMasterGainUpdate();
  });

  ySlider.addEventListener('input', () => {
    const y = parseFloat(ySlider.value);
    track.y = y;
    yValue.value = y.toFixed(2);
    audioEngine.updateTrackPosition(track.id, track.x, y);
    stageCanvas.updateTrackPosition(track.id, track.x, y);
    markUnsaved();
    maybeScheduleAutoMasterGainUpdate();
  });

  xValue.addEventListener('change', () => {
    let x = parseFloat(xValue.value);
    if (isNaN(x)) x = 0;
    x = Math.max(-1, Math.min(1, x));
    track.x = x;
    xSlider.value = x;
    xValue.value = x.toFixed(2);
    audioEngine.updateTrackPosition(track.id, x, track.y);
    stageCanvas.updateTrackPosition(track.id, x, track.y);
    markUnsaved();
    maybeScheduleAutoMasterGainUpdate();
  });

  yValue.addEventListener('change', () => {
    let y = parseFloat(yValue.value);
    if (isNaN(y)) y = 0;
    y = Math.max(0, Math.min(1, y));
    track.y = y;
    ySlider.value = y;
    yValue.value = y.toFixed(2);
    audioEngine.updateTrackPosition(track.id, track.x, y);
    stageCanvas.updateTrackPosition(track.id, track.x, y);
    markUnsaved();
    maybeScheduleAutoMasterGainUpdate();
  });

  gainSlider.addEventListener('input', () => {
    const gain = parseFloat(gainSlider.value);
    track.gain = gain;
    audioEngine.updateTrackGain(track.id, gain);
    stageCanvas.updateTrackGain(track.id, gain);
    maybeScheduleAutoMasterGainUpdate();
    markUnsaved();
  });

  soloBtn.addEventListener('click', () => {
    track.solo = !track.solo;
    soloBtn.classList.toggle('active', track.solo);
    audioEngine.updateTrackSolo(track.id, track.solo);
    stageCanvas.updateTrackSolo(track.id, track.solo);
    markUnsaved();
    maybeScheduleAutoMasterGainUpdate();
  });

  // Click to select
  el.addEventListener('click', (e) => {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
      selectTrack(track.id, e.shiftKey);
      stageCanvas.selectTrack(track.id);
    }
  });

  return el;
}

/**
 * Update a track list item
 */
function updateTrackListItem(trackId) {
  const track = state.tracks.get(trackId);
  if (!track) return;

  const el = document.querySelector(`.track-item[data-track-id="${trackId}"]`);
  if (!el) return;

  el.querySelector('.track-x-slider').value = track.x;
  el.querySelector('.track-x-value').value = track.x.toFixed(2);
  el.querySelector('.track-y-slider').value = track.y;
  el.querySelector('.track-y-value').value = track.y.toFixed(2);
  el.querySelector('.track-gain-slider').value = track.gain;
  el.querySelector('.track-mute').checked = !track.muted;
  el.querySelector('.track-solo').classList.toggle('active', track.solo);
}

/**
 * Select a track
 */
function selectTrack(trackId, multi = false) {
  if (!multi) {
    document.querySelectorAll('.track-item.selected').forEach(el => {
      el.classList.remove('selected');
    });
  }

  const el = document.querySelector(`.track-item[data-track-id="${trackId}"]`);
  if (el) {
    el.classList.add('selected');
  }
}

/**
 * Deselect all tracks
 */
function deselectAllTracks() {
  document.querySelectorAll('.track-item.selected').forEach(el => {
    el.classList.remove('selected');
  });
}

/**
 * Reset a single track position
 */
function resetTrackPosition(trackId) {
  const track = state.tracks.get(trackId);
  if (!track) return;

  track.x = track.defaultX;
  track.y = track.defaultY;

  audioEngine.updateTrackPosition(trackId, track.x, track.y);
  stageCanvas.updateTrackPosition(trackId, track.x, track.y);
  updateTrackListItem(trackId);
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Reset all positions
 */
function resetPositions() {
  for (const [id, track] of state.tracks) {
    track.x = track.defaultX;
    track.y = track.defaultY;
    audioEngine.updateTrackPosition(id, track.x, track.y);
    stageCanvas.updateTrackPosition(id, track.x, track.y);
  }
  buildTrackList();
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Reset all settings
 */
function resetAll() {
  for (const [id, track] of state.tracks) {
    track.x = track.defaultX;
    track.y = track.defaultY;
    track.gain = 1;
    track.muted = false;
    track.solo = false;
    audioEngine.updateTrackPosition(id, track.x, track.y);
    audioEngine.updateTrackGain(id, track.gain);
    audioEngine.updateTrackMuted(id, track.muted);
    audioEngine.updateTrackSolo(id, track.solo);
    stageCanvas.updateTrackPosition(id, track.x, track.y);
  }
  buildTrackList();
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Toggle playback
 */
async function togglePlayback() {
  await audioEngine.resume();

  if (audioEngine.isPlaying) {
    audioEngine.pause();
    stageCanvas.stopAnimationLoop();
    stopMasterMeterLoop();
    updatePlayButton(false);
  } else {
    await audioEngine.play();
    stageCanvas.startAnimationLoop();
    startMasterMeterLoop();
    updatePlayButton(true);
  }
}

/**
 * Stop playback
 */
function stopPlayback() {
  audioEngine.stop();
  stageCanvas.stopAnimationLoop();
  stopMasterMeterLoop();
  updatePlayButton(false);
  updateTimeDisplay(0, audioEngine.duration);
}

/**
 * Rewind to start
 */
function rewind() {
  audioEngine.seek(0);
  updateTimeDisplay(0, audioEngine.duration);
}

/**
 * Handle seek bar input
 */
function handleSeek(e) {
  const percent = parseFloat(e.target.value);
  const time = (percent / 100) * audioEngine.duration;
  audioEngine.seek(time);
}

/**
 * Handle master gain change
 */
function handleMasterGainChange(e) {
  const gainDb = parseFloat(e.target.value);
  if (!Number.isFinite(gainDb)) return;
  if (state.masterGainAuto) {
    state.masterGainAuto = false;
    if (elements.masterAuto) {
      elements.masterAuto.checked = false;
    }
    setMasterAutoStatus('');
  }
  setMasterGainDb(gainDb);
}

/**
 * Handle reverb preset change
 */
function handleReverbPresetChange(e) {
  state.reverbPreset = e.target.value;
  // Enable/disable reverb mode dropdown based on preset
  if (elements.reverbMode) {
    elements.reverbMode.disabled = (state.reverbPreset === 'none');
  }
  updateReverb();
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Handle reverb mode change
 */
function handleReverbModeChange(e) {
  state.reverbMode = e.target.value;
  audioEngine.setReverbMode(state.reverbMode);
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function gainToDb(gain) {
  const safeGain = Math.max(1e-4, gain);
  return 20 * Math.log10(safeGain);
}

function formatDb(db) {
  const rounded = Math.round(db * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)} dB`;
}

function formatDbFixed(db, { suffix = ' dB', empty = '--.- dB' } = {}) {
  if (!Number.isFinite(db)) return empty;
  const sign = db >= 0 ? '+' : '-';
  const absValue = Math.abs(db);
  const digits = absValue.toFixed(1).padStart(4, '0');
  return `${sign}${digits}${suffix}`;
}

function clampMasterGainDb(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.max(MASTER_GAIN_DB_MIN, Math.min(MASTER_GAIN_DB_MAX, db));
}

function setMasterGainDb(db, { skipSave = false } = {}) {
  const clampedDb = clampMasterGainDb(db);
  state.masterGainDb = clampedDb;
  if (audioEngine) {
    audioEngine.setMasterGain(dbToGain(clampedDb));
  }
  if (elements.masterGain) {
    elements.masterGain.value = clampedDb;
    elements.masterGain.disabled = state.masterGainAuto;
  }
  if (elements.masterGainValue) {
    elements.masterGainValue.textContent = formatDbFixed(clampedDb);
  }
  if (!skipSave) {
    markUnsaved();
  }
}

function setMasterAutoStatus(text) {
  if (!elements.masterAutoStatus) return;
  elements.masterAutoStatus.textContent = text || '';
  elements.masterAutoStatus.classList.toggle('hidden', !text);
}

function updateMasterAutoTargetLabel() {
  if (!elements.masterAutoTarget) return;
  elements.masterAutoTarget.textContent = formatDbFixed(MASTER_TARGET_RMS_DB, { suffix: ' dBFS' });
}

function handleMasterAutoToggle(e) {
  const enabled = e.target.checked;
  state.masterGainAuto = enabled;
  if (elements.masterGain) {
    elements.masterGain.disabled = enabled;
  }
  if (!enabled) {
    if (autoGainTimer) {
      clearTimeout(autoGainTimer);
      autoGainTimer = null;
    }
    if (autoGainController) {
      autoGainController.abort();
      autoGainController = null;
    }
    setMasterAutoStatus('');
  } else {
    scheduleAutoMasterGainUpdate({ delayMs: 0 });
  }
  markUnsaved();
}

function scheduleAutoMasterGainUpdate({ delayMs = MASTER_AUTO_DEBOUNCE_MS } = {}) {
  if (!audioEngine) return;
  if (!state.masterGainAuto || state.tracks.size === 0) return;
  if (autoGainTimer) {
    clearTimeout(autoGainTimer);
  }
  autoGainTimer = setTimeout(() => {
    autoGainTimer = null;
    updateAutoMasterGain();
  }, delayMs);
}

async function updateAutoMasterGain() {
  if (!audioEngine) return;
  if (!state.masterGainAuto || state.tracks.size === 0) return;

  const requestId = ++autoGainRequestId;
  if (autoGainController) {
    autoGainController.abort();
  }
  autoGainController = new AbortController();
  const controller = autoGainController;
  setMasterAutoStatus('Auto: analyzing...');

  try {
    const analysis = await audioEngine.analyzeMixLoudness({
      sampleRate: MASTER_ANALYSIS_SAMPLE_RATE,
      windowMs: MASTER_ANALYSIS_WINDOW_MS,
      percentile: MASTER_ANALYSIS_PERCENTILE,
      minDb: MASTER_ANALYSIS_MIN_DB,
      signal: autoGainController.signal,
      onProgress: (progress) => {
        if (requestId !== autoGainRequestId || !state.masterGainAuto) return;
        const percent = Math.round(progress * 100);
        setMasterAutoStatus(`Auto: analyzing ${percent}%`);
      },
    });

    if (requestId !== autoGainRequestId || !state.masterGainAuto) return;

    if (!Number.isFinite(analysis.percentileDb) || analysis.windowCount === 0) {
      setMasterAutoStatus('Auto: no signal');
      if (autoGainController === controller) {
        autoGainController = null;
      }
      return;
    }

    let gainDb = MASTER_TARGET_RMS_DB - analysis.percentileDb;
    if (Number.isFinite(analysis.peakDb)) {
      const predictedPeak = analysis.peakDb + gainDb;
      if (predictedPeak > MASTER_PEAK_LIMIT_DB) {
        gainDb -= (predictedPeak - MASTER_PEAK_LIMIT_DB);
      }
    }

    gainDb = clampMasterGainDb(gainDb);
    setMasterGainDb(gainDb, { skipSave: true });
    setMasterAutoStatus(`Auto: ${formatDbFixed(gainDb)}`);
    if (autoGainController === controller) {
      autoGainController = null;
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Auto master analysis failed:', error);
    setMasterAutoStatus('Auto: failed');
    if (autoGainController === controller) {
      autoGainController = null;
    }
  }
}

function updateMasterMeterDisplay() {
  if (!elements.masterMeterText || !elements.masterMeterFill) return;
  if (!audioEngine) return;

  const currentDb = audioEngine.getMasterLevelDb();
  if (!Number.isFinite(currentDb) || currentDb === -Infinity) {
    const targetLabel = formatDbFixed(MASTER_TARGET_RMS_DB, { suffix: ' dBFS' });
    elements.masterMeterText.textContent = `🔊 --.- dBFS | 🎯 ${targetLabel} | Δ --.- dB`;
    elements.masterMeterText.classList.remove('meter-ok', 'meter-low', 'meter-hot');
    elements.masterMeterFill.style.width = '0%';
    masterMeterSmoothedDb = null;
    return;
  }

  const smoothing = 0.2;
  if (masterMeterSmoothedDb === null) {
    masterMeterSmoothedDb = currentDb;
  } else {
    masterMeterSmoothedDb = currentDb * smoothing + masterMeterSmoothedDb * (1 - smoothing);
  }

  const delta = masterMeterSmoothedDb - MASTER_TARGET_RMS_DB;
  const outputLabel = formatDbFixed(masterMeterSmoothedDb, { suffix: ' dBFS' });
  const targetLabel = formatDbFixed(MASTER_TARGET_RMS_DB, { suffix: ' dBFS' });
  const deltaLabel = formatDbFixed(delta);

  elements.masterMeterText.textContent = `🔊 ${outputLabel} | 🎯 ${targetLabel} | Δ ${deltaLabel}`;
  elements.masterMeterText.classList.remove('meter-ok', 'meter-low', 'meter-hot');
  if (Math.abs(delta) <= 1) {
    elements.masterMeterText.classList.add('meter-ok');
  } else if (delta < -1) {
    elements.masterMeterText.classList.add('meter-low');
  } else {
    elements.masterMeterText.classList.add('meter-hot');
  }

  const clampedDelta = Math.max(-MASTER_METER_RANGE_DB, Math.min(MASTER_METER_RANGE_DB, delta));
  const percent = ((clampedDelta + MASTER_METER_RANGE_DB) / (MASTER_METER_RANGE_DB * 2)) * 100;
  elements.masterMeterFill.style.width = `${percent.toFixed(1)}%`;
}

function startMasterMeterLoop() {
  if (masterMeterFrameId) return;
  const tick = () => {
    updateMasterMeterDisplay();
    masterMeterFrameId = requestAnimationFrame(tick);
  };
  masterMeterFrameId = requestAnimationFrame(tick);
}

function stopMasterMeterLoop() {
  if (masterMeterFrameId) {
    cancelAnimationFrame(masterMeterFrameId);
    masterMeterFrameId = null;
  }
  updateMasterMeterDisplay();
}

function maybeScheduleAutoMasterGainUpdate() {
  if (!state.masterGainAuto) return;
  scheduleAutoMasterGainUpdate();
}

function updateReverbWetVisibility() {
  if (!elements.reverbWetControl) return;
  elements.reverbWetControl.classList.toggle('hidden', state.reverbPreset === 'none');
}

/**
 * Handle reverb wet change
 */
function handleReverbWetChange(e) {
  const wetDb = parseFloat(e.target.value);
  state.reverbWetDb = wetDb;
  audioEngine.setReverbWet(dbToGain(wetDb));
  elements.reverbWetValue.textContent = formatDb(wetDb);
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Handle ground reflection model change
 */
function handleGroundReflectionModelChange(e) {
  const modelId = e.target.value;
  if (modelId === 'none') {
    state.groundReflectionEnabled = false;
    audioEngine.setGroundReflection(false);
  } else {
    state.groundReflectionEnabled = true;
    state.groundReflectionModel = modelId;
    audioEngine.setGroundReflectionModel(modelId);
    audioEngine.setGroundReflection(true);
  }
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Handle mic technique change
 */
function handleMicTechniqueChange(e) {
  const techniqueId = e.target.value;
  state.micConfig = createMicrophoneConfig(techniqueId);
  state.micSeparation = state.micConfig.spacing;

  // Update wiki link for this technique
  if (elements.micTechniqueWiki && TECHNIQUE_WIKI[techniqueId]) {
    elements.micTechniqueWiki.href = TECHNIQUE_WIKI[techniqueId];
  }

  // Update UI visibility based on technique
  updateMicControlsUI();

  // Sync with audio engine and canvas
  audioEngine.setMicConfig(state.micConfig);
  stageCanvas.setMicConfig(state.micConfig);
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Handle mic polar pattern change
 */
function handleMicPatternChange(e) {
  const pattern = e.target.value;
  audioEngine.setMicPattern(pattern);
  state.micConfig = audioEngine.getMicConfig();
  stageCanvas.setMicConfig(state.micConfig);
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Handle mic spacing change
 */
function handleMicSpacingChange(e) {
  const spacing = parseFloat(e.target.value);
  state.micSeparation = spacing;
  state.micConfig.spacing = spacing;
  elements.micSpacingValue.textContent = `${spacing.toFixed(2)}m`;
  audioEngine.setMicSeparation(spacing);
  stageCanvas.setMicSeparation(spacing);
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Handle mic angle change
 */
function handleMicAngleChange(e) {
  const angle = parseFloat(e.target.value);
  state.micConfig.angle = angle;
  elements.micAngleValue.textContent = `${angle}°`;
  audioEngine.setMicAngle(angle);
  stageCanvas.setMicAngle(angle);
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Handle mic center depth change (Decca Tree)
 */
function handleMicCenterDepthChange(e) {
  const depth = parseFloat(e.target.value);
  state.micConfig.centerDepth = depth;
  elements.micCenterDepthValue.textContent = `${depth.toFixed(1)}m`;
  audioEngine.setCenterDepth(depth);
  stageCanvas.setCenterDepth(depth);
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Handle mic center level change (Decca Tree)
 */
function handleMicCenterLevelChange(e) {
  const level = parseFloat(e.target.value);
  state.micConfig.centerLevel = level;
  elements.micCenterLevelValue.textContent = `${level.toFixed(1)}dB`;
  audioEngine.setCenterLevel(level);
  markUnsaved();
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Update mic controls UI based on current technique
 */
function updateMicControlsUI() {
  const technique = STEREO_TECHNIQUES[state.micConfig.technique];
  if (!technique) return;

  // Update spacing slider
  if (elements.micSpacingControl) {
    const hasSpacing = technique.adjustable?.spacing;
    elements.micSpacingControl.classList.toggle('hidden', !hasSpacing);
    if (hasSpacing) {
      const { min, max, step } = technique.adjustable.spacing;
      elements.micSpacing.min = min;
      elements.micSpacing.max = max;
      elements.micSpacing.step = step;
      elements.micSpacing.value = state.micConfig.spacing;
      elements.micSpacingValue.textContent = `${state.micConfig.spacing.toFixed(2)}m`;
    }
  }

  // Update angle slider
  if (elements.micAngleControl) {
    const hasAngle = technique.adjustable?.angle;
    elements.micAngleControl.classList.toggle('hidden', !hasAngle);
    if (hasAngle) {
      const { min, max, step } = technique.adjustable.angle;
      elements.micAngle.min = min;
      elements.micAngle.max = max;
      elements.micAngle.step = step;
      elements.micAngle.value = state.micConfig.angle;
      elements.micAngleValue.textContent = `${state.micConfig.angle}°`;
    }
  }

  // Update center controls (Decca Tree only)
  if (elements.micCenterControls) {
    const hasCenter = technique.hasCenter;
    elements.micCenterControls.classList.toggle('hidden', !hasCenter);
    if (hasCenter) {
      elements.micCenterDepth.value = state.micConfig.centerDepth;
      elements.micCenterDepthValue.textContent = `${state.micConfig.centerDepth.toFixed(1)}m`;
      elements.micCenterLevel.value = state.micConfig.centerLevel;
      elements.micCenterLevelValue.textContent = `${state.micConfig.centerLevel.toFixed(1)}dB`;
    }
  }

  // Update pattern dropdown (disable for fixed pattern techniques like Blumlein)
  if (elements.micPattern) {
    const isFixed = !!technique.fixedPattern;
    elements.micPattern.disabled = isFixed;
    if (isFixed) {
      elements.micPattern.value = technique.fixedPattern;
    } else if (state.micConfig.mics[0]) {
      elements.micPattern.value = state.micConfig.mics[0].pattern;
    }
  }

  // Update technique dropdown
  if (elements.micTechnique) {
    elements.micTechnique.value = state.micConfig.technique;
  }
}

/**
 * Handle noise gate toggle
 */
function handleNoiseGateToggle(e) {
  const enabled = e.target.checked;
  state.noiseGateEnabled = enabled;

  // Update threshold control visibility
  elements.noiseGateThresholdContainer.classList.toggle('enabled', enabled);

  // Re-process all tracks with new noise gate setting
  reprocessTracksWithNoiseGate();
  markUnsaved();
}

/**
 * Handle noise gate threshold change
 */
function handleNoiseGateThresholdChange(e) {
  const threshold = parseInt(e.target.value, 10);
  state.noiseGateThreshold = threshold;
  elements.noiseGateThresholdValue.textContent = `${threshold}dB`;

  // Re-process tracks if noise gate is enabled
  if (state.noiseGateEnabled) {
    reprocessTracksWithNoiseGate();
  }
  markUnsaved();
}

/**
 * Initialize the noise gate Web Worker
 */
function initNoiseGateWorker() {
  if (noiseGateWorker) {
    try {
      noiseGateWorker.terminate();
    } catch {
      // Ignore
    }
  }

  noiseGateWorker = new Worker('js/noise-gate-worker.js');

  noiseGateWorker.onmessage = (e) => {
    const { type, outputData, buffers, taskId } = e.data;
    const pending = noiseGatePendingTasks.get(taskId);

    if (!pending) return;
    noiseGatePendingTasks.delete(taskId);

    const { sampleRate, resolve, isMulti, fallbackBuffer, fallbackBuffers, timeoutId } = pending;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (type === 'resultMulti' || isMulti) {
      // Multi-buffer response: convert each buffer's channels back to AudioBuffer
      if (!buffers || !buffers.length) {
        resolve({ buffers: fallbackBuffers || [], skipped: true, reason: 'worker_empty_response' });
        return;
      }
      const outputBuffers = buffers.map(buf => {
        const numChannels = buf.channels.length;
        const length = buf.channels[0].length;
        const ctx = new OfflineAudioContext(numChannels, length, sampleRate);
        const audioBuffer = ctx.createBuffer(numChannels, length, sampleRate);
        for (let ch = 0; ch < numChannels; ch++) {
          audioBuffer.getChannelData(ch).set(buf.channels[ch]);
        }
        return audioBuffer;
      });
      // Return with metadata for consistency with error path
      resolve({ buffers: outputBuffers, skipped: false });
    } else {
      // Single buffer response (original behavior)
      if (!outputData || !outputData.length) {
        resolve(fallbackBuffer);
        return;
      }
      const numChannels = outputData.length;
      const length = outputData[0].length;
      const ctx = new OfflineAudioContext(numChannels, length, sampleRate);
      const outputBuffer = ctx.createBuffer(numChannels, length, sampleRate);
      for (let ch = 0; ch < numChannels; ch++) {
        outputBuffer.getChannelData(ch).set(outputData[ch]);
      }
      resolve(outputBuffer);
    }
  };

  noiseGateWorker.onerror = (err) => {
    console.error('Noise gate worker error:', err);
    resolveAllNoiseGatePending('worker_error');
  };

  noiseGateWorker.onmessageerror = (err) => {
    console.error('Noise gate worker message error:', err);
    resolveAllNoiseGatePending('worker_message_error');
  };
}

function resolveAllNoiseGatePending(reason) {
  for (const [taskId, pending] of noiseGatePendingTasks.entries()) {
    const { resolve, isMulti, fallbackBuffer, fallbackBuffers, timeoutId } = pending;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (isMulti) {
      resolve({ buffers: fallbackBuffers || [], skipped: true, reason });
    } else {
      resolve(fallbackBuffer);
    }
    noiseGatePendingTasks.delete(taskId);
  }
  initNoiseGateWorker();
}

/**
 * Apply noise gate to an AudioBuffer using the Web Worker
 * @param {AudioBuffer} audioBuffer - Input buffer
 * @param {Object} options - Noise gate options
 * @returns {Promise<AudioBuffer>} - Processed buffer
 */
function applyNoiseGateAsync(audioBuffer, options = {}) {
  return new Promise((resolve) => {
    const taskId = ++noiseGateTaskId;
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;

    // Extract channel data as Float32Arrays
    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) {
      // Copy the data (worker will take ownership)
      channelData.push(new Float32Array(audioBuffer.getChannelData(ch)));
    }

    const timeoutId = setTimeout(() => {
      const pending = noiseGatePendingTasks.get(taskId);
      if (!pending) return;
      noiseGatePendingTasks.delete(taskId);
      resolve(audioBuffer);
    }, 60000);

    // Store pending task
    noiseGatePendingTasks.set(taskId, { sampleRate, resolve, fallbackBuffer: audioBuffer, timeoutId });

    // Send to worker (transfer buffers for efficiency)
    const transferList = channelData.map(arr => arr.buffer);
    try {
      noiseGateWorker.postMessage({
        channelData,
        sampleRate,
        options: {
          ...DEFAULT_NOISE_GATE_OPTIONS,
          ...options,
        },
        taskId,
      }, transferList);
    } catch (err) {
      console.error('Noise gate worker postMessage failed:', err);
      clearTimeout(timeoutId);
      noiseGatePendingTasks.delete(taskId);
      resolve(audioBuffer);
    }
  });
}

/**
 * Apply noise gate to multiple AudioBuffers with a SHARED envelope.
 * This ensures coherent gating across directivity buffers (front/bell)
 * to maintain stable imaging during blending.
 *
 * @param {AudioBuffer[]} audioBuffers - Array of input buffers
 * @param {Object} options - Noise gate options
 * @returns {Promise<AudioBuffer[]>} - Array of processed buffers (same order)
 */
function applyNoiseGateMultiAsync(audioBuffers, options = {}) {
  return new Promise((resolve) => {
    const taskId = ++noiseGateTaskId;

    // All buffers must have same sample rate
    const sampleRate = audioBuffers[0].sampleRate;

    // Validate all buffers have same sample rate - reject mismatches
    for (let i = 1; i < audioBuffers.length; i++) {
      if (audioBuffers[i].sampleRate !== sampleRate) {
        console.error(`Noise gate: sample rate mismatch - buffer ${i} has ${audioBuffers[i].sampleRate}Hz vs expected ${sampleRate}Hz. Skipping noise gate.`);
        // Return original buffers unprocessed with skipped flag
        resolve({ buffers: audioBuffers, skipped: true, reason: 'sample_rate_mismatch' });
        return;
      }
    }

    // Extract channel data from each buffer
    const buffers = audioBuffers.map(audioBuffer => {
      const channels = [];
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        // Copy the data (worker will take ownership)
        channels.push(new Float32Array(audioBuffer.getChannelData(ch)));
      }
      return { channels };
    });

    // Collect all ArrayBuffers for transfer
    const transferList = [];
    for (const buf of buffers) {
      for (const ch of buf.channels) {
        transferList.push(ch.buffer);
      }
    }

    const timeoutId = setTimeout(() => {
      const pending = noiseGatePendingTasks.get(taskId);
      if (!pending) return;
      noiseGatePendingTasks.delete(taskId);
      resolve({ buffers: audioBuffers, skipped: true, reason: 'timeout' });
    }, 60000);

    // Store pending task with multi flag
    noiseGatePendingTasks.set(taskId, {
      sampleRate,
      resolve,
      isMulti: true,
      fallbackBuffers: audioBuffers,
      timeoutId,
    });

    // Send to worker
    try {
      noiseGateWorker.postMessage({
        type: 'applyNoiseGateMulti',
        buffers,
        sampleRate,
        options: {
          ...DEFAULT_NOISE_GATE_OPTIONS,
          ...options,
        },
        taskId,
      }, transferList);
    } catch (err) {
      console.error('Noise gate worker postMessage failed:', err);
      clearTimeout(timeoutId);
      noiseGatePendingTasks.delete(taskId);
      resolve({ buffers: audioBuffers, skipped: true, reason: 'post_message_failed' });
    }
  });
}

/**
 * Yield to browser to allow paint and prevent UI freeze
 * Uses requestAnimationFrame + setTimeout to ensure paint happens
 */
function yieldToBrowser() {
  return new Promise(resolve => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function computeNoiseFloorDb(audioBuffer, options = {}) {
  const windowMs = options.windowMs ?? NOISE_FLOOR_ANALYSIS.windowMs;
  const percentile = options.percentile ?? NOISE_FLOOR_ANALYSIS.percentile;
  const maxWindows = options.maxWindows ?? NOISE_FLOOR_ANALYSIS.maxWindows;
  const minDb = options.minDb ?? NOISE_FLOOR_ANALYSIS.minDb;

  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
  const windowSamples = Math.max(1, Math.floor(audioBuffer.sampleRate * windowMs / 1000));
  const totalWindows = Math.floor(left.length / windowSamples);

  if (totalWindows === 0) return minDb;

  const stride = Math.max(1, Math.floor(totalWindows / maxWindows));
  const rmsDbValues = [];

  for (let w = 0; w < totalWindows; w += stride) {
    const start = w * windowSamples;
    const end = Math.min(start + windowSamples, left.length);
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      const l = left[i];
      if (right) {
        const r = right[i];
        sumSquares += 0.5 * (l * l + r * r);
      } else {
        sumSquares += l * l;
      }
    }
    const length = end - start;
    if (length === 0) continue;
    const rms = Math.sqrt(sumSquares / length);
    const db = rms > 0 ? 20 * Math.log10(rms) : minDb;
    rmsDbValues.push(Math.max(minDb, db));
  }

  if (!rmsDbValues.length) return minDb;

  rmsDbValues.sort((a, b) => a - b);
  const index = Math.min(rmsDbValues.length - 1, Math.floor(rmsDbValues.length * percentile));
  return rmsDbValues[index] ?? minDb;
}

async function computeNoiseFloorsForTracks() {
  const trackIds = Array.from(state.tracks.keys());
  if (!trackIds.length) return;

  setStatus('Analyzing noise floors...', 'info');
  await yieldToBrowser();

  for (let i = 0; i < trackIds.length; i++) {
    const id = trackIds[i];
    const track = state.tracks.get(id);
    if (!track) continue;

    if (i % 5 === 0) {
      setStatus(`Analyzing noise floors... (${i + 1}/${trackIds.length})`, 'info');
      await yieldToBrowser();
    }

    const noiseFloorByMic = new Map();
    const primaryMic = track.primaryMicPosition || '6';
    const targetMics = new Set([primaryMic, '8']);
    if (track.originalAlternateBuffers && track.originalAlternateBuffers.size) {
      for (const [micPos, buf] of track.originalAlternateBuffers.entries()) {
        if (!targetMics.has(micPos)) continue;
        noiseFloorByMic.set(micPos, computeNoiseFloorDb(buf));
      }
    } else if (track.originalBuffer) {
      noiseFloorByMic.set(primaryMic, computeNoiseFloorDb(track.originalBuffer));
    }

    track.noiseFloorByMic = noiseFloorByMic;
    track.noiseFloorDb = noiseFloorByMic.get(primaryMic)
      ?? noiseFloorByMic.values().next().value
      ?? NOISE_FLOOR_ANALYSIS.minDb;
  }
}

/**
 * Apply noise gate to all tracks (for initial load)
 * Uses shared envelope for directivity buffers to maintain imaging coherence
 */
async function applyNoiseGateToAllTracks() {
  setStatus('Applying noise gate...', 'info');
  await yieldToBrowser();

  const trackIds = Array.from(state.tracks.keys());
  const deferRebuild = audioEngine.isPlaying;
  let needsRebuild = false;

  for (let i = 0; i < trackIds.length; i++) {
    const id = trackIds[i];
    const track = state.tracks.get(id);
    if (!track) continue;

    setStatus(`Applying noise gate... (${i + 1}/${trackIds.length})`, 'info');

    // Check if track has directivity buffers that need shared envelope
    // Filter to only directivity pair (front/bell) to avoid unrelated mic noise affecting gate
    const primaryMicPos = track.primaryMicPosition || '6';
    const bellMicPos = '8';
    if (track.originalAlternateBuffers && track.originalAlternateBuffers.size > 1) {
      // Filter to only the directivity pair (primary mic + bell mic 8)
      const directivityEntries = [...track.originalAlternateBuffers.entries()]
        .filter(([micPos, _]) => micPos === primaryMicPos || micPos === bellMicPos);

      // Only use shared envelope if we have both mics of the directivity pair
      if (directivityEntries.length > 1) {
        const directivityBuffers = directivityEntries.map(([_, buf]) => buf);

        // Process directivity pair with unified envelope
        const result = await applyNoiseGateMultiAsync(directivityBuffers, {
          thresholdDb: state.noiseGateThreshold,
        });

        if (result.skipped) {
          console.warn(`Noise gate skipped for track due to ${result.reason}`);
          // Skip gating for all mics to keep envelopes consistent
          track.alternateBuffers = new Map(track.originalAlternateBuffers);
          track.audioBuffer = track.alternateBuffers.get(primaryMicPos) || track.originalBuffer;
          audioEngine.updateTrackBuffer(id, track.audioBuffer, { deferRebuild });
          audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers, { deferRebuild });
          if (deferRebuild) needsRebuild = true;
          continue;
        }
        const processedBuffers = result.buffers;

        // Store processed directivity buffers back
        track.alternateBuffers = new Map();
        directivityEntries.forEach(([micPos, _], idx) => {
          track.alternateBuffers.set(micPos, processedBuffers[idx]);
        });

        // Copy any non-directivity mics unprocessed (or process individually)
        for (const [micPos, buf] of track.originalAlternateBuffers.entries()) {
          if (!track.alternateBuffers.has(micPos)) {
            // Process non-directivity mics individually
            const processedBuf = await applyNoiseGateAsync(buf, {
              thresholdDb: state.noiseGateThreshold,
            });
            track.alternateBuffers.set(micPos, processedBuf);
          }
        }
      } else {
        // Only one mic from directivity pair - process all individually
        track.alternateBuffers = new Map();
        for (const [micPos, buf] of track.originalAlternateBuffers.entries()) {
          const processedBuf = await applyNoiseGateAsync(buf, {
            thresholdDb: state.noiseGateThreshold,
          });
          track.alternateBuffers.set(micPos, processedBuf);
        }
      }

      // Update main buffer to the primary mic's processed version
      track.audioBuffer = track.alternateBuffers.get(primaryMicPos);
      audioEngine.updateTrackBuffer(id, track.audioBuffer, { deferRebuild });
      audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers, { deferRebuild });
      if (deferRebuild) needsRebuild = true;
    } else {
      // Single buffer - use standard processing
      const sourceBuffer = track.originalBuffer || track.audioBuffer;
      const processedBuffer = await applyNoiseGateAsync(sourceBuffer, {
        thresholdDb: state.noiseGateThreshold,
      });
      track.audioBuffer = processedBuffer;
      audioEngine.updateTrackBuffer(id, track.audioBuffer, { deferRebuild });
      if (deferRebuild) needsRebuild = true;
    }
  }

  if (needsRebuild) {
    audioEngine.scheduleGraphRebuild({ delayMs: 0 });
  }

  setStatus(`Loaded ${state.tracks.size} tracks (noise gate applied)`, 'success');
  maybeScheduleAutoMasterGainUpdate();
}

/**
 * Re-process all tracks with current noise gate settings
 * Uses generation counter to prevent stale async results from being committed
 * Uses shared envelope for directivity buffers to maintain imaging coherence
 */
async function reprocessTracksWithNoiseGate() {
  // Increment generation to invalidate any in-flight processing
  const thisGeneration = ++noiseGateGeneration;

  const action = state.noiseGateEnabled ? 'Applying' : 'Removing';
  setStatus(`${action} noise gate...`, 'info');
  await yieldToBrowser();

  // Check if a newer request has come in
  if (thisGeneration !== noiseGateGeneration) return;

  const trackIds = Array.from(state.tracks.keys());
  const deferRebuild = audioEngine.isPlaying;
  let needsRebuild = false;

  for (let i = 0; i < trackIds.length; i++) {
    // Check if a newer request has come in
    if (thisGeneration !== noiseGateGeneration) return;

    const id = trackIds[i];
    const track = state.tracks.get(id);
    if (!track) continue;

    setStatus(`${action} noise gate... (${i + 1}/${trackIds.length})`, 'info');

    if (state.noiseGateEnabled) {
      // Check if track has directivity buffers that need shared envelope
      // Filter to only directivity pair (front/bell) to avoid unrelated mic noise affecting gate
      const primaryMicPos = track.primaryMicPosition || '6';
      const bellMicPos = '8';
      if (track.originalAlternateBuffers && track.originalAlternateBuffers.size > 1) {
        // Filter to only the directivity pair (primary mic + bell mic 8)
        const directivityEntries = [...track.originalAlternateBuffers.entries()]
          .filter(([micPos, _]) => micPos === primaryMicPos || micPos === bellMicPos);

        // Only use shared envelope if we have both mics of the directivity pair
        if (directivityEntries.length > 1) {
          const directivityBuffers = directivityEntries.map(([_, buf]) => buf);

          // Process directivity pair with unified envelope
          const result = await applyNoiseGateMultiAsync(directivityBuffers, {
            thresholdDb: state.noiseGateThreshold,
          });

          if (result.skipped) {
            console.warn(`Noise gate skipped for track ${id} during reprocess due to ${result.reason}`);
            if (thisGeneration !== noiseGateGeneration) return;
            // Skip gating for all mics to keep envelopes consistent
            track.alternateBuffers = new Map();
            for (const [micPos, origBuf] of track.originalAlternateBuffers.entries()) {
              track.alternateBuffers.set(micPos, copyAudioBuffer(origBuf));
            }
            track.audioBuffer = track.alternateBuffers.get(primaryMicPos) || track.originalBuffer;
            audioEngine.updateTrackBuffer(id, track.audioBuffer, { deferRebuild });
            audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers, { deferRebuild });
            if (deferRebuild) needsRebuild = true;
            continue;
          }
          const processedBuffers = result.buffers;

          // Check again after async operation
          if (thisGeneration !== noiseGateGeneration) return;

          // Store processed directivity buffers back
          track.alternateBuffers = new Map();
          directivityEntries.forEach(([micPos, _], idx) => {
            track.alternateBuffers.set(micPos, processedBuffers[idx]);
          });

          // Process any non-directivity mics individually
          for (const [micPos, buf] of track.originalAlternateBuffers.entries()) {
            if (!track.alternateBuffers.has(micPos)) {
              const processedBuf = await applyNoiseGateAsync(buf, {
                thresholdDb: state.noiseGateThreshold,
              });
              if (thisGeneration !== noiseGateGeneration) return;
              track.alternateBuffers.set(micPos, processedBuf);
            }
          }
        } else {
          // Only one mic from directivity pair - process all individually
          track.alternateBuffers = new Map();
          for (const [micPos, buf] of track.originalAlternateBuffers.entries()) {
            const processedBuf = await applyNoiseGateAsync(buf, {
              thresholdDb: state.noiseGateThreshold,
            });
            if (thisGeneration !== noiseGateGeneration) return;
            track.alternateBuffers.set(micPos, processedBuf);
          }
        }

        // Update main buffer to the primary mic's processed version
        track.audioBuffer = track.alternateBuffers.get(primaryMicPos);
        audioEngine.updateTrackBuffer(id, track.audioBuffer, { deferRebuild });
        audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers, { deferRebuild });
        if (deferRebuild) needsRebuild = true;
      } else {
        // Single buffer - use standard processing
        const sourceBuffer = track.originalBuffer || track.audioBuffer;
        const processedBuffer = await applyNoiseGateAsync(sourceBuffer, {
          thresholdDb: state.noiseGateThreshold,
        });
        // Check again after async operation
        if (thisGeneration !== noiseGateGeneration) return;
        track.audioBuffer = processedBuffer;
        audioEngine.updateTrackBuffer(id, track.audioBuffer, { deferRebuild });
        if (deferRebuild) needsRebuild = true;
      }
    } else {
      // Restore original buffers
      track.audioBuffer = track.originalBuffer ? copyAudioBuffer(track.originalBuffer) : track.audioBuffer;
      audioEngine.updateTrackBuffer(id, track.audioBuffer, { deferRebuild });
      if (deferRebuild) needsRebuild = true;

      // Also restore alternate buffers if present
      if (track.originalAlternateBuffers) {
        track.alternateBuffers = new Map();
        for (const [micPos, origBuf] of track.originalAlternateBuffers) {
          track.alternateBuffers.set(micPos, copyAudioBuffer(origBuf));
        }
        audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers, { deferRebuild });
        if (deferRebuild) needsRebuild = true;
      }
    }
  }

  if (thisGeneration === noiseGateGeneration && needsRebuild) {
    audioEngine.scheduleGraphRebuild({ delayMs: 0 });
  }

  // Only show completion message if this was the most recent request
  if (thisGeneration === noiseGateGeneration) {
    setStatus(state.noiseGateEnabled ? 'Noise gate applied' : 'Noise gate removed', 'success');
    showToast(state.noiseGateEnabled ? 'Noise gate applied' : 'Noise gate disabled', 'info');
    maybeScheduleAutoMasterGainUpdate();
  }
}

/**
 * Update reverb settings
 */
function updateReverb() {
  const ir = reverbManager.getImpulseResponse(state.reverbPreset);
  const presetInfo = reverbManager.getPresetInfo(state.reverbPreset);
  audioEngine.setReverbPreset(state.reverbPreset, ir, presetInfo.wet || 0);
  audioEngine.setReverbWet(dbToGain(state.reverbWetDb));
  audioEngine.setReverbMode(state.reverbMode);
  updateReverbWetVisibility();
}

/**
 * Update play button state
 */
function updatePlayButton(isPlaying) {
  const playIcon = elements.playBtn.querySelector('.play-icon');
  const pauseIcon = elements.playBtn.querySelector('.pause-icon');

  if (isPlaying) {
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');
  } else {
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
  }
}

/**
 * Update time display
 */
function updateTimeDisplay(currentTime, duration) {
  const formatTime = (t) => {
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  elements.timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;

  if (duration > 0) {
    elements.seekBar.value = (currentTime / duration) * 100;
  }
}

/**
 * Handle playback end (called when audio reaches end naturally)
 */
function handlePlaybackEnd() {
  stageCanvas.stopAnimationLoop();
  stopMasterMeterLoop();
  updatePlayButton(false);
}

/**
 * Update transport UI
 */
function updateTransportUI() {
  updateTimeDisplay(0, audioEngine.duration);
  elements.masterGain.value = state.masterGainDb;
  elements.masterGain.disabled = state.masterGainAuto;
  elements.masterGainValue.textContent = formatDbFixed(state.masterGainDb);
  updateMasterAutoTargetLabel();
  if (elements.masterAuto) {
    elements.masterAuto.checked = state.masterGainAuto;
  }
  setMasterAutoStatus('');
  updateMasterMeterDisplay();
  elements.reverbPreset.value = state.reverbPreset;
  if (elements.reverbMode) {
    elements.reverbMode.value = state.reverbMode;
    elements.reverbMode.disabled = (state.reverbPreset === 'none');
  }
  elements.reverbWet.value = state.reverbWetDb;
  elements.reverbWetValue.textContent = formatDb(state.reverbWetDb);
  updateReverbWetVisibility();
  if (elements.groundReflectionModel) {
    elements.groundReflectionModel.value = state.groundReflectionEnabled
      ? state.groundReflectionModel
      : 'none';
  }
}

/**
 * Generate a shareable URL with compressed config
 */
function getShareableURL() {
  const config = createSessionState(state);
  const json = JSON.stringify(config);
  const compressed = pako.deflate(json);
  const base64 = btoa(String.fromCharCode(...compressed))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, ''); // URL-safe base64
  return `${location.origin}${location.pathname}#c=${base64}`;
}

/**
 * Detect if a profile name matches a built-in profile
 * (e.g., 'mahler_mp3' -> 'mahler', 'Mozart - Don Giovanni' -> 'mozart')
 */
function detectBuiltInProfile(profileName) {
  if (!profileName) return null;
  const nameLower = profileName.toLowerCase();

  // Check for each built-in profile key
  for (const key of Object.keys(PROFILES)) {
    // Match if profileName starts with or contains the profile key
    // e.g., 'mahler_mp3' starts with 'mahler'
    if (nameLower.startsWith(key) || nameLower.includes(key)) {
      return key;
    }
  }
  return null;
}

/**
 * Load config from URL hash - shows confirmation modal
 */
function loadFromURL() {
  const hash = location.hash;
  if (!hash.startsWith('#c=')) return false;

  try {
    // Decode URL-safe base64
    let base64 = hash.slice(3)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    // Add padding if needed
    while (base64.length % 4) base64 += '=';

    const compressed = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const json = pako.inflate(compressed, { to: 'string' });
    const config = JSON.parse(json);

    // Validate config has profile
    if (!config.profile) {
      showToast('Invalid shared configuration', 'error');
      return false;
    }

    // Check if it's a built-in profile or custom
    let isBuiltInProfile = !!PROFILES[config.profile];

    // If custom profile, try to detect built-in profile from profileName
    // (e.g., 'mahler_mp3' -> 'mahler', 'Mozart - Don Giovanni' -> 'mozart')
    if (!isBuiltInProfile && config.profileName) {
      const detectedProfile = detectBuiltInProfile(config.profileName);
      if (detectedProfile) {
        config.profile = detectedProfile;
        isBuiltInProfile = true;
      }
    }

    // Store pending config and show confirmation modal
    pendingSharedConfig = config;
    const summary = buildConfigSummary(config, isBuiltInProfile);
    elements.shareModalDetails.innerHTML = summary;
    showShareModal();
    return true;
  } catch (error) {
    console.error('Failed to load config from URL:', error);
    showToast('Failed to load shared configuration', 'error');
  }
  return false;
}

/**
 * Build human-readable summary of shared config
 */
function buildConfigSummary(config, isBuiltInProfile = true) {
  const profile = PROFILES[config.profile];
  const lines = [];

  // Recording name
  if (isBuiltInProfile) {
    lines.push(`<p><strong>Recording:</strong> ${profile?.fullName || config.profile}</p>`);
  } else {
    // Custom profile - user needs to upload the recording
    const displayName = config.profileName || 'Custom recording';
    lines.push(`<p><strong>Recording:</strong> ${displayName}</p>`);
    lines.push('<p class="hint" style="margin-top: 8px; font-size: 12px; color: var(--ink-soft);">⚠️ Upload the same recording first, then these settings will be applied.</p>');
  }
  lines.push('<ul class="config-summary">');

  // Track settings
  if (config.tracks) {
    const trackCount = Object.keys(config.tracks).length;
    let mutedCount = 0, soloCount = 0, gainAdjusted = 0;
    for (const t of Object.values(config.tracks)) {
      if (t.muted) mutedCount++;
      if (t.solo) soloCount++;
      if (t.gain !== undefined && t.gain !== 1) gainAdjusted++;
    }
    const parts = [`${trackCount} tracks`];
    if (gainAdjusted > 0) parts.push(`${gainAdjusted} gain adjusted`);
    if (mutedCount > 0) parts.push(`${mutedCount} muted`);
    if (soloCount > 0) parts.push(`${soloCount} solo`);
    lines.push(`<li>Track positions: ${parts.join(', ')}</li>`);
  }

  // Master gain
  if (config.masterGainDb !== undefined) {
    const autoStr = config.masterGainAuto ? ' (auto)' : '';
    lines.push(`<li>Master gain: ${config.masterGainDb >= 0 ? '+' : ''}${config.masterGainDb.toFixed(1)} dB${autoStr}</li>`);
  }

  // Reverb
  if (config.reverbPreset && config.reverbPreset !== 'none') {
    const presetName = config.reverbPreset.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const modeStr = config.reverbMode ? ` (${config.reverbMode})` : '';
    const wetStr = config.reverbWetDb !== undefined ? `, ${config.reverbWetDb >= 0 ? '+' : ''}${config.reverbWetDb.toFixed(1)} dB wet` : '';
    lines.push(`<li>Reverb: ${presetName}${modeStr}${wetStr}</li>`);
  }

  // Mic technique
  if (config.micConfig) {
    const technique = STEREO_TECHNIQUES[config.micConfig.technique];
    const techniqueName = technique?.name || config.micConfig.technique;
    const pattern = config.micConfig.pattern ? POLAR_PATTERNS[config.micConfig.pattern] : null;
    const patternName = pattern?.shortName || config.micConfig.pattern || '';
    const spacingStr = config.micConfig.spacing ? `${config.micConfig.spacing.toFixed(2)}m` : '';
    const angleStr = config.micConfig.angle ? `${config.micConfig.angle}°` : '';
    const details = [patternName, spacingStr, angleStr].filter(Boolean).join(', ');
    lines.push(`<li>Mic technique: ${techniqueName}${details ? ` (${details})` : ''}</li>`);
  }

  // Ground reflection
  if (config.groundReflectionModel && config.groundReflectionModel !== 'none') {
    const modelName = config.groundReflectionModel.replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`<li>Ground reflection: ${modelName}</li>`);
  }

  // Noise gate
  if (config.noiseGateEnabled) {
    const thresholdStr = config.noiseGateThreshold !== undefined ? ` (${config.noiseGateThreshold} dB)` : '';
    lines.push(`<li>Noise gate: enabled${thresholdStr}</li>`);
  }

  lines.push('</ul>');
  return lines.join('\n');
}

/**
 * Show share confirmation modal
 */
function showShareModal() {
  elements.shareModal.classList.remove('hidden');
}

/**
 * Hide share confirmation modal
 */
function hideShareModal() {
  elements.shareModal.classList.add('hidden');
}

/**
 * Confirm loading shared config
 */
async function confirmSharedConfig() {
  hideShareModal();

  if (!pendingSharedConfig) return;

  const config = pendingSharedConfig;
  const profile = PROFILES[config.profile];

  // Handle custom profiles - keep pending config and wait for user to upload
  if (!profile) {
    showToast('Upload the recording to apply these settings', 'info');
    // pendingSharedConfig stays set - will be applied when user uploads
    history.replaceState(null, '', location.pathname);
    return;
  }

  // Update radio button for visual consistency
  const profileRadio = document.querySelector(`input[name="profile"][value="${config.profile}"]`);
  if (profileRadio) profileRadio.checked = true;

  // Load the profile directly from config
  await loadProfile(config.profile, profile.url, profile.fullName);

  // Apply settings (pendingSharedConfig is applied in loadProfile's success path
  // or manually if CORS fails and user uploads manually)
  if (state.tracks.size > 0) {
    applySharedConfig(config);
    pendingSharedConfig = null;
    showToast('Loaded shared arrangement', 'success');
  }
  // If CORS failed, pendingSharedConfig remains set for manual upload fallback

  // Clear hash to avoid re-loading on refresh
  history.replaceState(null, '', location.pathname);
}

/**
 * Cancel loading shared config
 */
function cancelSharedConfig() {
  hideShareModal();
  pendingSharedConfig = null;
  // Clear hash
  history.replaceState(null, '', location.pathname);
}

/**
 * Apply shared config to current state
 */
function applySharedConfig(config) {
  // Apply track settings
  if (config.tracks) {
    for (const [id, track] of state.tracks) {
      const saved = config.tracks[track.filename];
      if (saved) {
        track.x = saved.x ?? track.x;
        track.y = saved.y ?? track.y;
        track.gain = saved.gain ?? track.gain;
        track.muted = saved.muted ?? track.muted;
        track.solo = saved.solo ?? track.solo;

        // Update audio engine's internal track (it maintains separate copy)
        audioEngine.updateTrackPosition(id, track.x, track.y);
      }
    }
  }

  // Apply master settings
  if (config.masterGainDb !== undefined) {
    state.masterGainDb = config.masterGainDb;
    elements.masterGain.value = config.masterGainDb;
    audioEngine.setMasterGain(Math.pow(10, config.masterGainDb / 20));
  }
  if (config.masterGainAuto !== undefined) {
    state.masterGainAuto = config.masterGainAuto;
    if (elements.masterAuto) elements.masterAuto.checked = config.masterGainAuto;
  }

  // Apply reverb settings
  if (config.reverbPreset) {
    state.reverbPreset = config.reverbPreset;
    elements.reverbPreset.value = config.reverbPreset;
  }
  if (config.reverbMode) {
    state.reverbMode = config.reverbMode;
    if (elements.reverbMode) {
      elements.reverbMode.value = config.reverbMode;
      elements.reverbMode.disabled = (config.reverbPreset === 'none');
    }
  }
  if (config.reverbWetDb !== undefined) {
    state.reverbWetDb = config.reverbWetDb;
    elements.reverbWet.value = config.reverbWetDb;
    elements.reverbWetValue.textContent = formatDb(config.reverbWetDb);
  }
  updateReverb();

  // Apply mic config
  if (config.micConfig) {
    state.micConfig = config.micConfig;
    state.micSeparation = config.micConfig.spacing;
    audioEngine.setMicConfig(config.micConfig);
    stageCanvas.setMicConfig(config.micConfig);
    updateMicControlsUI();
  }

  // Apply ground reflection
  if (config.groundReflectionModel) {
    state.groundReflectionModel = config.groundReflectionModel;
    state.groundReflectionEnabled = config.groundReflectionModel !== 'none';
    if (elements.groundReflectionModel) {
      elements.groundReflectionModel.value = config.groundReflectionModel;
    }
    audioEngine.setGroundReflectionModel(
      state.groundReflectionEnabled ? config.groundReflectionModel : null
    );
  }

  // Apply noise gate
  if (config.noiseGateEnabled !== undefined) {
    state.noiseGateEnabled = config.noiseGateEnabled;
    elements.noiseGateCheckbox.checked = config.noiseGateEnabled;
  }
  if (config.noiseGateThreshold !== undefined) {
    state.noiseGateThreshold = config.noiseGateThreshold;
    elements.noiseGateThreshold.value = config.noiseGateThreshold;
    elements.noiseGateThresholdValue.textContent = `${config.noiseGateThreshold}dB`;
  }

  // Rebuild audio graph and update UI
  audioEngine.rebuildGraph();
  stageCanvas.setTracks(state.tracks);
  renderTrackList();
  updateMasterGainDisplay();

  // Mark as having changes (enables share button)
  markUnsaved();
}

/**
 * Share current config via URL
 */
function shareConfig() {
  const url = getShareableURL();
  navigator.clipboard.writeText(url).then(() => {
    showToast('Share URL copied to clipboard!', 'success');
  }).catch(() => {
    // Fallback: show URL in prompt
    prompt('Copy this URL to share your configuration:', url);
  });
}

/**
 * Download WAV
 */
async function downloadWav() {
  if (state.tracks.size === 0) return;

  showRenderModal();

  renderAbortController = new AbortController();

  try {
    const buffer = await audioEngine.renderOffline(
      updateRenderProgress,
      renderAbortController.signal
    );

    const wavData = audioBufferToWav(buffer);
    const blob = createWavBlob(wavData);
    const filename = generateFilename(state.currentProfile, 'wav');

    downloadBlob(blob, filename);
    hideRenderModal();
    showToast('WAV file downloaded!', 'success');

  } catch (error) {
    if (error.name === 'AbortError') {
      showToast('Render cancelled', 'info');
    } else {
      console.error('Failed to render WAV:', error);
      showToast('Failed to render WAV', 'error');
    }
    hideRenderModal();
  }

  renderAbortController = null;
}

/**
 * Download MP3
 */
async function downloadMp3() {
  if (state.tracks.size === 0) return;

  if (!isLameJsAvailable()) {
    showToast('MP3 encoder not available', 'error');
    return;
  }

  showRenderModal();

  renderAbortController = new AbortController();

  try {
    // First render to audio buffer
    const buffer = await audioEngine.renderOffline(
      (p) => updateRenderProgress(p * 0.5),
      renderAbortController.signal
    );

    // Then encode to MP3
    const blob = await audioBufferToMp3(buffer, 192, (p) => updateRenderProgress(0.5 + p * 0.5));

    const filename = generateFilename(state.currentProfile, 'mp3');
    downloadBlob(blob, filename);
    hideRenderModal();
    showToast('MP3 file downloaded!', 'success');

  } catch (error) {
    if (error.name === 'AbortError') {
      showToast('Render cancelled', 'info');
    } else {
      console.error('Failed to render MP3:', error);
      showToast('Failed to render MP3', 'error');
    }
    hideRenderModal();
  }

  renderAbortController = null;
}

/**
 * Cancel render
 */
function cancelRender() {
  if (renderAbortController) {
    renderAbortController.abort();
  }
}

/**
 * Update render progress
 */
function updateRenderProgress(progress) {
  const percent = Math.round(progress * 100);
  elements.renderProgressFill.style.width = `${percent}%`;
  elements.renderProgressText.textContent = `${percent}%`;
}

/**
 * Show render modal
 */
function showRenderModal() {
  elements.renderModal.classList.remove('hidden');
  elements.renderProgressFill.style.width = '0%';
  elements.renderProgressText.textContent = '0%';
}

/**
 * Hide render modal
 */
function hideRenderModal() {
  elements.renderModal.classList.add('hidden');
}

/**
 * Show restore modal
 */
function showRestoreModal() {
  elements.restoreModal.classList.remove('hidden');
}

/**
 * Hide restore modal
 */
function hideRestoreModal() {
  elements.restoreModal.classList.add('hidden');
}

/**
 * Restore saved session
 */
async function restoreSession() {
  hideRestoreModal();

  const session = loadSession();
  if (!session) return;

  // Apply settings
  const savedMasterGainDb = Number.isFinite(session.masterGainDb)
    ? session.masterGainDb
    : gainToDb(session.masterGain ?? 1.0);
  state.masterGainDb = clampMasterGainDb(savedMasterGainDb);
  state.masterGainAuto = session.masterGainAuto ?? true;
  state.reverbPreset = session.reverbPreset ?? 'concert-hall';
  state.reverbMode = session.reverbMode ?? 'depth';
  const savedWetDb = Number.isFinite(session.reverbWetDb)
    ? session.reverbWetDb
    : (Number.isFinite(session.reverbWet) ? gainToDb(session.reverbWet) : 0);
  state.reverbWetDb = Math.min(6, Math.max(-24, savedWetDb));
  state.micSeparation = session.micSeparation ?? 2;
  state.groundReflectionEnabled = session.groundReflectionEnabled ?? false;
  state.groundReflectionModel = session.groundReflectionModel ?? state.groundReflectionModel;
  state.noiseGateEnabled = session.noiseGateEnabled ?? false;
  state.noiseGateThreshold = session.noiseGateThreshold ?? -70;
  state.showPolarPatterns = true;
  // Restore mic config if available, otherwise use default
  if (session.micConfig) {
    state.micConfig = session.micConfig;
    state.micSeparation = state.micConfig.spacing;
  }

  audioEngine.setMasterGain(dbToGain(state.masterGainDb));
  audioEngine.setMicConfig(state.micConfig);
  audioEngine.setGroundReflection(state.groundReflectionEnabled);
  audioEngine.setGroundReflectionModel(state.groundReflectionModel);
  updateReverb();
  updateTransportUI();

  // Update microphone controls UI
  updateMicControlsUI();
  stageCanvas.setMicConfig(state.micConfig);
  stageCanvas.setShowPolarPatterns(true);
  if (elements.groundReflectionModel) {
    elements.groundReflectionModel.value = state.groundReflectionEnabled
      ? state.groundReflectionModel
      : 'none';
  }
  elements.noiseGateCheckbox.checked = state.noiseGateEnabled;
  elements.noiseGateThreshold.value = state.noiseGateThreshold;
  elements.noiseGateThresholdValue.textContent = `${state.noiseGateThreshold}dB`;
  elements.noiseGateThresholdContainer.classList.toggle('enabled', state.noiseGateEnabled);

  // If there was a profile, prompt to reload
  if (session.profile && PROFILES[session.profile]) {
    const profile = PROFILES[session.profile];
    showToast(`Restoring ${profile.name}...`, 'info');

    await loadProfile(session.profile, profile.url, profile.fullName);

    // Apply saved track positions
    if (session.tracks) {
      applySessionToTracks(state.tracks, session.tracks);

      // Update UI and audio engine
      for (const [id, track] of state.tracks) {
        audioEngine.updateTrackPosition(id, track.x, track.y);
        audioEngine.updateTrackGain(id, track.gain);
        audioEngine.updateTrackMuted(id, track.muted);
        audioEngine.updateTrackSolo(id, track.solo);
        stageCanvas.updateTrackPosition(id, track.x, track.y);
      }

      buildTrackList();
    }
  }

  if (state.masterGainAuto) {
    scheduleAutoMasterGainUpdate({ delayMs: 0 });
  }

  state.hasUnsavedChanges = false;
}

/**
 * Save current session
 */
function saveCurrentSession() {
  const sessionState = createSessionState({
    tracks: state.tracks,
    currentProfile: state.currentProfile,
    currentProfileName: state.currentProfileName,
    masterGainDb: state.masterGainDb,
    masterGainAuto: state.masterGainAuto,
    reverbPreset: state.reverbPreset,
    reverbMode: state.reverbMode,
    micSeparation: state.micSeparation,
    micConfig: state.micConfig,
    groundReflectionEnabled: state.groundReflectionEnabled,
    groundReflectionModel: state.groundReflectionModel,
    noiseGateEnabled: state.noiseGateEnabled,
    noiseGateThreshold: state.noiseGateThreshold,
  });

  saveSession(sessionState);
  state.hasUnsavedChanges = false;
}

/**
 * Mark state as having unsaved changes
 */
function markUnsaved() {
  state.hasUnsavedChanges = true;
  updateShareButtonState();

  // Auto-save after a delay (use pre-created debounced function)
  if (debouncedSaveSession) {
    debouncedSaveSession();
  }
}

/**
 * Toggle track list collapse state
 */
function toggleTrackList() {
  elements.trackListSection.classList.toggle('collapsed');
}

/**
 * Update track count display
 */
function updateTrackCount() {
  elements.trackCount.textContent = `(${state.tracks.size})`;
}

/**
 * Update profile name in header
 */
function updateProfileName() {
  elements.profileName.textContent = state.currentProfileName || '';
}

/**
 * Enable export buttons
 */
function enableExportButtons() {
  elements.downloadWavBtn.disabled = false;
  elements.downloadMp3Btn.disabled = false;
}

/**
 * Disable export buttons
 */
function disableExportButtons() {
  elements.downloadWavBtn.disabled = true;
  elements.downloadMp3Btn.disabled = true;
}

/**
 * Update share button state - enabled only when there are changes vs defaults
 */
function updateShareButtonState() {
  if (!elements.shareBtn) return;
  // Enable if tracks loaded AND there are unsaved changes
  elements.shareBtn.disabled = !(state.tracks.size > 0 && state.hasUnsavedChanges);
}

/**
 * Show progress indicator
 */
function showProgress(text) {
  elements.loadProgress.classList.remove('hidden');
  elements.progressFill.style.width = '0%';
  elements.progressText.textContent = text;
}

/**
 * Update progress
 */
function updateProgress(progress) {
  const percent = Math.round(progress * 100);
  elements.progressFill.style.width = `${percent}%`;
  elements.progressText.textContent = `${percent}%`;
}

/**
 * Hide progress indicator
 */
function hideProgress() {
  elements.loadProgress.classList.add('hidden');
}

/**
 * Set status text
 */
function setStatus(text, type = 'info') {
  // Use innerHTML if text contains HTML (for download links on error)
  if (text.includes('<a ')) {
    elements.statusText.innerHTML = text;
  } else {
    elements.statusText.textContent = text;
  }
  elements.statusText.className = type;
}

/**
 * Show a toast notification
 */
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  elements.toastContainer.appendChild(toast);

  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
