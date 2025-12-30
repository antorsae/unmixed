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
  masterGain: 1.0,
  reverbPreset: 'none',
  reverbMode: 'depth',
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

// Noise gate worker
let noiseGateWorker = null;
let noiseGateTaskId = 0;
const noiseGatePendingTasks = new Map();
let noiseGateGeneration = 0; // For serializing async reprocessing

// Render state
let renderAbortController = null;

// Debounced save function (created once, reused)
let debouncedSaveSession = null;

// DOM elements
const elements = {};

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

  // Check for saved session
  if (hasSession()) {
    showRestoreModal();
  }

  // Set initial reverb
  updateReverb();

  // Update UI
  updateTransportUI();
  updateMicControlsUI();
  if (elements.groundReflectionModel) {
    elements.groundReflectionModel.value = state.groundReflectionModel;
    elements.groundReflectionModel.disabled = !state.groundReflectionEnabled;
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
  elements.reverbPreset = document.getElementById('reverb-preset');
  elements.groundReflectionCheckbox = document.getElementById('ground-reflection-checkbox');
  elements.groundReflectionModel = document.getElementById('ground-reflection-model');
  // Microphone controls
  elements.micTechnique = document.getElementById('mic-technique');
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
  elements.showPolarPatterns = document.getElementById('show-polar-patterns');
  // Legacy (for compatibility)
  elements.micSeparation = elements.micSpacing;
  elements.micSeparationValue = elements.micSpacingValue;
  elements.resetPositionsBtn = document.getElementById('reset-positions-btn');
  elements.resetAllBtn = document.getElementById('reset-all-btn');
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

  // Reverb controls
  elements.reverbPreset.addEventListener('change', handleReverbPresetChange);
  document.querySelectorAll('input[name="reverb-mode"]').forEach(radio => {
    radio.addEventListener('change', handleReverbModeChange);
  });

  // Physics controls
  elements.groundReflectionCheckbox.addEventListener('change', handleGroundReflectionChange);
  elements.groundReflectionModel?.addEventListener('change', handleGroundReflectionModelChange);

  // Microphone controls
  elements.micTechnique?.addEventListener('change', handleMicTechniqueChange);
  elements.micPattern?.addEventListener('change', handleMicPatternChange);
  elements.micSpacing?.addEventListener('input', handleMicSpacingChange);
  elements.micAngle?.addEventListener('input', handleMicAngleChange);
  elements.micCenterDepth?.addEventListener('input', handleMicCenterDepthChange);
  elements.micCenterLevel?.addEventListener('input', handleMicCenterLevelChange);
  elements.showPolarPatterns?.addEventListener('change', handleShowPolarPatternsChange);

  // Noise gate controls
  elements.noiseGateCheckbox.addEventListener('change', handleNoiseGateToggle);
  elements.noiseGateThreshold.addEventListener('input', handleNoiseGateThresholdChange);

  // Track list toggle
  elements.trackListHeader.addEventListener('click', toggleTrackList);

  // Reset buttons
  elements.resetPositionsBtn.addEventListener('click', resetPositions);
  elements.resetAllBtn.addEventListener('click', resetAll);

  // Download buttons
  elements.downloadWavBtn.addEventListener('click', downloadWav);
  elements.downloadMp3Btn.addEventListener('click', downloadMp3);
  elements.cancelRenderBtn.addEventListener('click', cancelRender);

  // Restore modal
  elements.restoreYesBtn.addEventListener('click', restoreSession);
  elements.restoreNoBtn.addEventListener('click', () => {
    clearSession();
    hideRestoreModal();
  });

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
      audioEngine.updateTrackPosition(trackId, x, y);
      updateTrackListItem(trackId);
      markUnsaved();
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
    }
  };

  stageCanvas.onTrackGainChange = (trackId, newGain) => {
    const track = state.tracks.get(trackId);
    if (track) {
      track.gain = newGain;
      audioEngine.updateTrackGain(trackId, newGain);
      updateTrackListItem(trackId);
      markUnsaved();
    }
  };

  stageCanvas.onTrackMuteToggle = (trackId, muted) => {
    const track = state.tracks.get(trackId);
    if (track) {
      track.muted = muted;
      audioEngine.updateTrackMuted(trackId, muted);
      updateTrackListItem(trackId);
      markUnsaved();
    }
  };

  stageCanvas.onTrackSoloToggle = (trackId, solo) => {
    const track = state.tracks.get(trackId);
    if (track) {
      track.solo = solo;
      audioEngine.updateTrackSolo(trackId, solo);
      updateTrackListItem(trackId);
      markUnsaved();
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
  };

  // Full mic config change callback (from canvas drag)
  stageCanvas.onMicConfigChange = (config) => {
    state.micConfig = config;
    state.micSeparation = config.spacing;
    updateMicControlsUI();
    audioEngine.setMicConfig(config);
    markUnsaved();
  };

  // Initialize canvas with mic config from state
  stageCanvas.setMicConfig(state.micConfig);
  stageCanvas.setShowPolarPatterns(state.showPolarPatterns);
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
    finalizeTracks();
    hideProgress();
    setStatus(`Loaded ${state.tracks.size} tracks`, 'success');
    updateProfileName();
    enableExportButtons();

  } catch (error) {
    console.error('Failed to load profile:', error);
    setStatus(error.message, 'error');
    showToast(error.message, 'error');
    hideProgress();
    pendingFiles = []; // Clear pending files on error
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

    finalizeTracks();
    hideProgress();
    setStatus(`Loaded ${state.tracks.size} tracks`, 'success');
    updateProfileName();
    enableExportButtons();

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

    finalizeTracks();
    hideProgress();
    setStatus(`Loaded ${state.tracks.size} tracks`, 'success');
    updateProfileName();
    enableExportButtons();

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
function finalizeTracks() {
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

  el.innerHTML = `
    <input type="checkbox" class="track-mute" ${track.muted ? '' : 'checked'} title="Enable/Disable">
    <span class="track-name" style="color: ${FAMILY_COLORS[track.family]}">${track.name}</span>
    ${hasDirectivity ? '<span class="directivity-badge" title="Directivity simulation active (blends front/bell mics based on position)">DIR</span>' : ''}
    <div class="track-controls">
      <div class="track-control">
        <label>X:</label>
        <input type="range" class="track-x-slider" min="-1" max="1" step="0.01" value="${track.x}">
        <input type="text" class="value-input track-x-value" value="${track.x.toFixed(2)}">
      </div>
      <div class="track-control">
        <label>Y:</label>
        <input type="range" class="track-y-slider" min="0" max="1" step="0.01" value="${track.y}">
        <input type="text" class="value-input track-y-value" value="${track.y.toFixed(2)}">
      </div>
      <div class="track-control">
        <label>Gain:</label>
        <input type="range" class="track-gain-slider" min="0" max="2" step="0.01" value="${track.gain}">
      </div>
      <button class="track-solo ${track.solo ? 'active' : ''}">S</button>
    </div>
  `;

  // Event listeners
  const muteCheckbox = el.querySelector('.track-mute');
  const xSlider = el.querySelector('.track-x-slider');
  const ySlider = el.querySelector('.track-y-slider');
  const xValue = el.querySelector('.track-x-value');
  const yValue = el.querySelector('.track-y-value');
  const gainSlider = el.querySelector('.track-gain-slider');
  const soloBtn = el.querySelector('.track-solo');

  muteCheckbox.addEventListener('change', () => {
    track.muted = !muteCheckbox.checked;
    audioEngine.updateTrackMuted(track.id, track.muted);
    stageCanvas.updateTrackMuted(track.id, track.muted);
    markUnsaved();
  });

  xSlider.addEventListener('input', () => {
    const x = parseFloat(xSlider.value);
    track.x = x;
    xValue.value = x.toFixed(2);
    audioEngine.updateTrackPosition(track.id, x, track.y);
    stageCanvas.updateTrackPosition(track.id, x, track.y);
    markUnsaved();
  });

  ySlider.addEventListener('input', () => {
    const y = parseFloat(ySlider.value);
    track.y = y;
    yValue.value = y.toFixed(2);
    audioEngine.updateTrackPosition(track.id, track.x, y);
    stageCanvas.updateTrackPosition(track.id, track.x, y);
    markUnsaved();
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
  });

  gainSlider.addEventListener('input', () => {
    const gain = parseFloat(gainSlider.value);
    track.gain = gain;
    audioEngine.updateTrackGain(track.id, gain);
    stageCanvas.updateTrackGain(track.id, gain);
    markUnsaved();
  });

  soloBtn.addEventListener('click', () => {
    track.solo = !track.solo;
    soloBtn.classList.toggle('active', track.solo);
    audioEngine.updateTrackSolo(track.id, track.solo);
    stageCanvas.updateTrackSolo(track.id, track.solo);
    markUnsaved();
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
}

/**
 * Toggle playback
 */
async function togglePlayback() {
  await audioEngine.resume();

  if (audioEngine.isPlaying) {
    audioEngine.pause();
    stageCanvas.stopAnimationLoop();
    updatePlayButton(false);
  } else {
    await audioEngine.play();
    stageCanvas.startAnimationLoop();
    updatePlayButton(true);
  }
}

/**
 * Stop playback
 */
function stopPlayback() {
  audioEngine.stop();
  stageCanvas.stopAnimationLoop();
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
  const gain = parseFloat(e.target.value);
  state.masterGain = gain;
  audioEngine.setMasterGain(gain);
  elements.masterGainValue.textContent = gain.toFixed(2);
  markUnsaved();
}

/**
 * Handle reverb preset change
 */
function handleReverbPresetChange(e) {
  state.reverbPreset = e.target.value;
  updateReverb();
  markUnsaved();
}

/**
 * Handle reverb mode change
 */
function handleReverbModeChange(e) {
  state.reverbMode = e.target.value;
  audioEngine.setReverbMode(state.reverbMode);
  markUnsaved();
}

/**
 * Handle ground reflection toggle
 */
function handleGroundReflectionChange(e) {
  const enabled = e.target.checked;
  state.groundReflectionEnabled = enabled;
  audioEngine.setGroundReflection(enabled);
  if (elements.groundReflectionModel) {
    elements.groundReflectionModel.disabled = !enabled;
  }
  markUnsaved();
}

/**
 * Handle ground reflection model change
 */
function handleGroundReflectionModelChange(e) {
  const modelId = e.target.value;
  state.groundReflectionModel = modelId;
  audioEngine.setGroundReflectionModel(modelId);
  markUnsaved();
}

/**
 * Handle mic technique change
 */
function handleMicTechniqueChange(e) {
  const techniqueId = e.target.value;
  state.micConfig = createMicrophoneConfig(techniqueId);
  state.micSeparation = state.micConfig.spacing;

  // Update UI visibility based on technique
  updateMicControlsUI();

  // Sync with audio engine and canvas
  audioEngine.setMicConfig(state.micConfig);
  stageCanvas.setMicConfig(state.micConfig);
  markUnsaved();
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
}

/**
 * Handle polar pattern visibility toggle
 */
function handleShowPolarPatternsChange(e) {
  const show = e.target.checked;
  state.showPolarPatterns = show;
  stageCanvas.setShowPolarPatterns(show);
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
  noiseGateWorker = new Worker('js/noise-gate-worker.js');

  noiseGateWorker.onmessage = (e) => {
    const { type, outputData, buffers, taskId } = e.data;
    const pending = noiseGatePendingTasks.get(taskId);

    if (!pending) return;
    noiseGatePendingTasks.delete(taskId);

    const { sampleRate, resolve, isMulti } = pending;

    if (type === 'resultMulti' || isMulti) {
      // Multi-buffer response: convert each buffer's channels back to AudioBuffer
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

    // Store pending task
    noiseGatePendingTasks.set(taskId, { sampleRate, resolve });

    // Send to worker (transfer buffers for efficiency)
    const transferList = channelData.map(arr => arr.buffer);
    noiseGateWorker.postMessage({
      channelData,
      sampleRate,
      options: {
        ...DEFAULT_NOISE_GATE_OPTIONS,
        ...options,
      },
      taskId,
    }, transferList);
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

    // Store pending task with multi flag
    noiseGatePendingTasks.set(taskId, { sampleRate, resolve, isMulti: true });

    // Send to worker
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

/**
 * Apply noise gate to all tracks (for initial load)
 * Uses shared envelope for directivity buffers to maintain imaging coherence
 */
async function applyNoiseGateToAllTracks() {
  setStatus('Applying noise gate...', 'info');
  await yieldToBrowser();

  const trackIds = Array.from(state.tracks.keys());

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
          audioEngine.updateTrackBuffer(id, track.audioBuffer);
          audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers);
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
      audioEngine.updateTrackBuffer(id, track.audioBuffer);
      audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers);
    } else {
      // Single buffer - use standard processing
      const sourceBuffer = track.originalBuffer || track.audioBuffer;
      const processedBuffer = await applyNoiseGateAsync(sourceBuffer, {
        thresholdDb: state.noiseGateThreshold,
      });
      track.audioBuffer = processedBuffer;
      audioEngine.updateTrackBuffer(id, track.audioBuffer);
    }
  }

  setStatus(`Loaded ${state.tracks.size} tracks (noise gate applied)`, 'success');
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
            audioEngine.updateTrackBuffer(id, track.audioBuffer);
            audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers);
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
        audioEngine.updateTrackBuffer(id, track.audioBuffer);
        audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers);
      } else {
        // Single buffer - use standard processing
        const sourceBuffer = track.originalBuffer || track.audioBuffer;
        const processedBuffer = await applyNoiseGateAsync(sourceBuffer, {
          thresholdDb: state.noiseGateThreshold,
        });
        // Check again after async operation
        if (thisGeneration !== noiseGateGeneration) return;
        track.audioBuffer = processedBuffer;
        audioEngine.updateTrackBuffer(id, track.audioBuffer);
      }
    } else {
      // Restore original buffers
      track.audioBuffer = track.originalBuffer ? copyAudioBuffer(track.originalBuffer) : track.audioBuffer;
      audioEngine.updateTrackBuffer(id, track.audioBuffer);

      // Also restore alternate buffers if present
      if (track.originalAlternateBuffers) {
        track.alternateBuffers = new Map();
        for (const [micPos, origBuf] of track.originalAlternateBuffers) {
          track.alternateBuffers.set(micPos, copyAudioBuffer(origBuf));
        }
        audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers);
      }
    }
  }

  // Only show completion message if this was the most recent request
  if (thisGeneration === noiseGateGeneration) {
    setStatus(state.noiseGateEnabled ? 'Noise gate applied' : 'Noise gate removed', 'success');
    showToast(state.noiseGateEnabled ? 'Noise gate applied' : 'Noise gate disabled', 'info');
  }
}

/**
 * Update reverb settings
 */
function updateReverb() {
  const ir = reverbManager.getImpulseResponse(state.reverbPreset);
  const presetInfo = reverbManager.getPresetInfo(state.reverbPreset);
  audioEngine.setReverbPreset(state.reverbPreset, ir, presetInfo.wet || 0);
  audioEngine.setReverbMode(state.reverbMode);
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
  updatePlayButton(false);
}

/**
 * Update transport UI
 */
function updateTransportUI() {
  updateTimeDisplay(0, audioEngine.duration);
  elements.masterGain.value = state.masterGain;
  elements.masterGainValue.textContent = state.masterGain.toFixed(2);
  elements.reverbPreset.value = state.reverbPreset;
  document.querySelector(`input[name="reverb-mode"][value="${state.reverbMode}"]`).checked = true;
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
  state.masterGain = session.masterGain ?? 1.0;
  state.reverbPreset = session.reverbPreset ?? 'concert-hall';
  state.reverbMode = session.reverbMode ?? 'depth';
  state.micSeparation = session.micSeparation ?? 2;
  state.groundReflectionEnabled = session.groundReflectionEnabled ?? false;
  state.groundReflectionModel = session.groundReflectionModel ?? state.groundReflectionModel;
  state.noiseGateEnabled = session.noiseGateEnabled ?? false;
  state.noiseGateThreshold = session.noiseGateThreshold ?? -70;
  state.showPolarPatterns = session.showPolarPatterns ?? true;
  // Restore mic config if available, otherwise use default
  if (session.micConfig) {
    state.micConfig = session.micConfig;
    state.micSeparation = state.micConfig.spacing;
  }

  audioEngine.setMasterGain(state.masterGain);
  audioEngine.setMicConfig(state.micConfig);
  audioEngine.setGroundReflection(state.groundReflectionEnabled);
  audioEngine.setGroundReflectionModel(state.groundReflectionModel);
  updateReverb();
  updateTransportUI();

  // Update microphone controls UI
  updateMicControlsUI();
  stageCanvas.setMicConfig(state.micConfig);
  stageCanvas.setShowPolarPatterns(state.showPolarPatterns);
  elements.showPolarPatterns.checked = state.showPolarPatterns;
  elements.groundReflectionCheckbox.checked = state.groundReflectionEnabled;
  if (elements.groundReflectionModel) {
    elements.groundReflectionModel.value = state.groundReflectionModel;
    elements.groundReflectionModel.disabled = !state.groundReflectionEnabled;
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
    masterGain: state.masterGain,
    reverbPreset: state.reverbPreset,
    reverbMode: state.reverbMode,
    micSeparation: state.micSeparation,
    micConfig: state.micConfig,
    showPolarPatterns: state.showPolarPatterns,
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
  elements.statusText.textContent = text;
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
