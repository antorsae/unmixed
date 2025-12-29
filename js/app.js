// Main application entry point

import { PROFILES, FAMILY_ORDER, FAMILY_COLORS } from './positions.js';
import { parseTrackFilename, applyInstanceSpreading, generateTrackId, sortTracksByFamily, getMicLabel } from './track-parser.js';
import { AudioEngine } from './audio-engine.js';
import { StageCanvas } from './stage-canvas.js?v=3';
import { loadZipFromUrl, loadZipFromFile, extractAudioFiles, loadAudioFiles, mightNeedCorsProxy } from './zip-loader.js?v=3';
import { audioBufferToWav, createWavBlob, downloadBlob, generateFilename } from './wav-encoder.js';
import { audioBufferToMp3, isLameJsAvailable } from './mp3-encoder.js';
import { ReverbManager, REVERB_PRESETS } from './reverb.js';
import { saveSession, loadSession, clearSession, hasSession, createSessionState, applySessionToTracks, setupUnloadWarning, debounce } from './persistence.js';
import { copyAudioBuffer, DEFAULT_NOISE_GATE_OPTIONS } from './noise-gate.js';

// Application state
const state = {
  tracks: new Map(), // trackId -> full track data
  currentProfile: null,
  currentProfileName: null,
  masterGain: 0.8,
  reverbPreset: 'none',
  reverbMode: 'depth',
  groundReflectionEnabled: false,
  micSeparation: 2, // meters
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

// Render state
let renderAbortController = null;

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

  // Set up event listeners
  setupEventListeners();

  // Set up keyboard shortcuts
  setupKeyboardShortcuts();

  // Set up auto-save
  const debouncedSave = debounce(() => {
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
  elements.micSeparation = document.getElementById('mic-separation');
  elements.micSeparationValue = document.getElementById('mic-separation-value');
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
  elements.micSeparation.addEventListener('input', handleMicSeparationChange);

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

  // Mic separation drag on canvas
  stageCanvas.onMicSeparationChange = (separation) => {
    state.micSeparation = separation;
    elements.micSeparation.value = separation;
    elements.micSeparationValue.textContent = `${separation.toFixed(1)}m`;
    audioEngine.setMicSeparation(separation);
    markUnsaved();
  };

  // Initialize canvas mic separation from state
  stageCanvas.setMicSeparation(state.micSeparation);
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
        e.preventDefault();
        rewind();
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

  state.isLoading = true;
  state.currentProfile = profileKey;
  state.currentProfileName = displayName;

  // Auto-enable noise gate for Aalto anechoic recordings
  const aaltoProfiles = ['mozart', 'beethoven', 'bruckner', 'mahler'];
  if (aaltoProfiles.includes(profileKey)) {
    state.noiseGateEnabled = true;
    elements.noiseGateCheckbox.checked = true;
    elements.noiseGateThresholdContainer.classList.add('enabled');
  }

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
  }

  state.isLoading = false;
}

/**
 * Handle ZIP file upload
 */
async function handleZipUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (state.isLoading) return;

  stopPlayback();
  clearTracks();

  state.isLoading = true;
  state.currentProfile = 'custom';
  state.currentProfileName = file.name.replace('.zip', '');

  showProgress('Loading ZIP...');
  setStatus('Loading ZIP file...', 'info');

  try {
    const zip = await loadZipFromFile(file, updateProgress);

    setStatus('Extracting audio files...', 'info');
    updateProgress(0);

    await extractAudioFiles(zip, async (file) => {
      await processAudioFile(file.filename, file.arrayBuffer);
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
  }

  state.isLoading = false;
  elements.zipInput.value = '';
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
    elements.zipInput.files = files;
    await handleZipUpload({ target: elements.zipInput });
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

  // Show directivity indicator if multiple mics available
  const hasDirectivity = track.availableMics && track.availableMics.length > 1;

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
    updatePlayButton(false);
  } else {
    await audioEngine.play();
    updatePlayButton(true);
  }
}

/**
 * Stop playback
 */
function stopPlayback() {
  audioEngine.stop();
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
  markUnsaved();
}

/**
 * Handle mic separation change
 */
function handleMicSeparationChange(e) {
  const separation = parseFloat(e.target.value);
  state.micSeparation = separation;
  elements.micSeparationValue.textContent = `${separation.toFixed(1)}m`;
  audioEngine.setMicSeparation(separation);
  stageCanvas.setMicSeparation(separation);
  markUnsaved();
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
    const { outputData, taskId } = e.data;
    const pending = noiseGatePendingTasks.get(taskId);

    if (pending) {
      noiseGatePendingTasks.delete(taskId);

      // Convert Float32Arrays back to AudioBuffer
      const { sampleRate, resolve } = pending;
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

    // Process main buffer using worker
    const sourceBuffer = track.originalBuffer || track.audioBuffer;
    const processedBuffer = await applyNoiseGateAsync(sourceBuffer, {
      thresholdDb: state.noiseGateThreshold,
    });
    track.audioBuffer = processedBuffer;
    audioEngine.updateTrackBuffer(id, track.audioBuffer);

    // Process alternate buffers if present
    if (track.originalAlternateBuffers) {
      track.alternateBuffers = new Map();
      for (const [micPos, origBuf] of track.originalAlternateBuffers) {
        const processed = await applyNoiseGateAsync(origBuf, {
          thresholdDb: state.noiseGateThreshold,
        });
        track.alternateBuffers.set(micPos, processed);
      }
      audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers);
    }
  }

  setStatus(`Loaded ${state.tracks.size} tracks (noise gate applied)`, 'success');
}

/**
 * Re-process all tracks with current noise gate settings
 */
async function reprocessTracksWithNoiseGate() {
  const action = state.noiseGateEnabled ? 'Applying' : 'Removing';
  setStatus(`${action} noise gate...`, 'info');
  await yieldToBrowser();

  const trackIds = Array.from(state.tracks.keys());

  for (let i = 0; i < trackIds.length; i++) {
    const id = trackIds[i];
    const track = state.tracks.get(id);
    if (!track) continue;

    setStatus(`${action} noise gate... (${i + 1}/${trackIds.length})`, 'info');

    // Use original buffer if available, otherwise the current buffer
    const sourceBuffer = track.originalBuffer || track.audioBuffer;

    if (state.noiseGateEnabled) {
      // Apply noise gate using worker
      const processedBuffer = await applyNoiseGateAsync(sourceBuffer, {
        thresholdDb: state.noiseGateThreshold,
      });
      track.audioBuffer = processedBuffer;
    } else {
      // Restore original
      track.audioBuffer = track.originalBuffer ? copyAudioBuffer(track.originalBuffer) : track.audioBuffer;
    }

    // Update audio engine with new buffer
    audioEngine.updateTrackBuffer(id, track.audioBuffer);

    // Also process alternate buffers if present
    if (track.originalAlternateBuffers) {
      track.alternateBuffers = new Map();
      for (const [micPos, origBuf] of track.originalAlternateBuffers) {
        if (state.noiseGateEnabled) {
          const processed = await applyNoiseGateAsync(origBuf, {
            thresholdDb: state.noiseGateThreshold,
          });
          track.alternateBuffers.set(micPos, processed);
        } else {
          track.alternateBuffers.set(micPos, copyAudioBuffer(origBuf));
        }
      }
      // Update directivity buffers in audio engine
      audioEngine.updateTrackDirectivityBuffers(id, track.alternateBuffers);
    }
  }

  setStatus(state.noiseGateEnabled ? 'Noise gate applied' : 'Noise gate removed', 'success');
  showToast(state.noiseGateEnabled ? 'Noise gate applied' : 'Noise gate disabled', 'info');
}

/**
 * Update reverb settings
 */
function updateReverb() {
  const ir = reverbManager.getImpulseResponse(state.reverbPreset);
  audioEngine.setReverbPreset(state.reverbPreset, ir);
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
 * Handle playback end
 */
function handlePlaybackEnd() {
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
  state.masterGain = session.masterGain ?? 0.8;
  state.reverbPreset = session.reverbPreset ?? 'concert-hall';
  state.reverbMode = session.reverbMode ?? 'depth';

  audioEngine.setMasterGain(state.masterGain);
  updateReverb();
  updateTransportUI();

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
  });

  saveSession(sessionState);
  state.hasUnsavedChanges = false;
}

/**
 * Mark state as having unsaved changes
 */
function markUnsaved() {
  state.hasUnsavedChanges = true;

  // Auto-save after a delay
  if (state.tracks.size > 0) {
    debounce(saveCurrentSession, 1000)();
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
