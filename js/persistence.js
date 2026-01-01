// LocalStorage persistence for session state

const STORAGE_KEY = 'orchestral-mixer-session';
const VERSION = 1;

/**
 * Session state structure
 */
const defaultState = {
  version: VERSION,
  profile: null,
  profileName: null,
  tracks: {}, // filename -> { x, y, gain, muted, solo }
  masterGain: 1.0,
  masterGainDb: 0,
  masterGainAuto: true,
  reverbPreset: 'none',
  reverbMode: 'depth',
  reverbWetDb: 0,
  groundReflectionModel: 'stage',
  savedAt: null,
};

/**
 * Save session state to localStorage
 * @param {Object} state - State to save
 */
export function saveSession(state) {
  try {
    const session = {
      ...defaultState,
      ...state,
      savedAt: new Date().toISOString(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    return true;
  } catch (error) {
    console.error('Failed to save session:', error);
    return false;
  }
}

/**
 * Load session state from localStorage
 * @returns {Object|null} - Saved state or null
 */
export function loadSession() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);

    if (!data) {
      return null;
    }

    const session = JSON.parse(data);

    // Check version compatibility
    if (session.version !== VERSION) {
      console.warn('Session version mismatch, ignoring saved session');
      return null;
    }

    return session;
  } catch (error) {
    console.error('Failed to load session:', error);
    return null;
  }
}

/**
 * Clear saved session
 */
export function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (error) {
    console.error('Failed to clear session:', error);
    return false;
  }
}

/**
 * Check if a session exists
 * @returns {boolean} - Whether a session exists
 */
export function hasSession() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Get session summary for display
 * @returns {Object|null} - Session summary
 */
export function getSessionSummary() {
  const session = loadSession();

  if (!session) {
    return null;
  }

  return {
    profile: session.profile,
    profileName: session.profileName,
    trackCount: Object.keys(session.tracks).length,
    savedAt: session.savedAt ? new Date(session.savedAt) : null,
  };
}

/**
 * Create a session state object from app state
 * @param {Object} appState - Application state
 * @returns {Object} - Session state for saving
 */
export function createSessionState(appState) {
  const tracks = {};

  for (const [id, track] of appState.tracks) {
    tracks[track.filename] = {
      x: track.x,
      y: track.y,
      gain: track.gain,
      muted: track.muted,
      solo: track.solo,
    };
  }

  return {
    version: VERSION,
    profile: appState.currentProfile,
    profileName: appState.currentProfileName,
    tracks,
    masterGain: Math.pow(10, (appState.masterGainDb ?? 0) / 20),
    masterGainDb: appState.masterGainDb ?? 0,
    masterGainAuto: appState.masterGainAuto ?? false,
    reverbPreset: appState.reverbPreset,
    reverbMode: appState.reverbMode,
    reverbWetDb: appState.reverbWetDb,
    // Additional settings
    micSeparation: appState.micSeparation,
    micConfig: appState.micConfig,
    showPolarPatterns: appState.showPolarPatterns,
    groundReflectionEnabled: appState.groundReflectionEnabled,
    groundReflectionModel: appState.groundReflectionModel,
    noiseGateEnabled: appState.noiseGateEnabled,
    noiseGateThreshold: appState.noiseGateThreshold,
  };
}

/**
 * Apply saved session state to tracks
 * @param {Map} tracks - Current tracks map
 * @param {Object} savedTracks - Saved track states
 */
export function applySessionToTracks(tracks, savedTracks) {
  for (const [id, track] of tracks) {
    const saved = savedTracks[track.filename];

    if (saved) {
      track.x = saved.x ?? track.x;
      track.y = saved.y ?? track.y;
      track.gain = saved.gain ?? track.gain;
      track.muted = saved.muted ?? track.muted;
      track.solo = saved.solo ?? track.solo;
    }
  }
}

/**
 * Set up beforeunload warning for unsaved changes
 * @param {Function} hasUnsavedChanges - Function that returns whether there are unsaved changes
 */
export function setupUnloadWarning(hasUnsavedChanges) {
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges()) {
      e.preventDefault();
      e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
      return e.returnValue;
    }
  });
}

/**
 * Debounce function for auto-saving
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in ms
 * @returns {Function} - Debounced function
 */
export function debounce(func, wait) {
  let timeout;

  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };

    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
