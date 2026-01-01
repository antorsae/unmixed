// Microphone Types - Polar patterns, stereo techniques, and presets
// For realistic microphone simulation in the orchestral mixer

/**
 * Polar pattern definitions
 * Formula: G(theta) = alpha + (1 - alpha) * cos(theta)
 * where alpha is the omnidirectional component
 */
export const POLAR_PATTERNS = {
  omni: {
    id: 'omni',
    name: 'Omnidirectional',
    shortName: 'Omni',
    alpha: 1.0, // G = 1 (constant in all directions)
    description: 'Equal pickup from all directions',
    color: '#4CAF50', // Green
  },
  cardioid: {
    id: 'cardioid',
    name: 'Cardioid',
    shortName: 'Card',
    alpha: 0.5, // G = 0.5 * (1 + cos(theta))
    description: 'Heart-shaped, rejects rear sound',
    color: '#2196F3', // Blue
  },
  supercardioid: {
    id: 'supercardioid',
    name: 'Supercardioid',
    shortName: 'Super',
    alpha: 0.37, // G = 0.37 + 0.63 * cos(theta)
    description: 'Narrower than cardioid with small rear lobe',
    color: '#9C27B0', // Purple
  },
  hypercardioid: {
    id: 'hypercardioid',
    name: 'Hypercardioid',
    shortName: 'Hyper',
    alpha: 0.25, // G = 0.25 + 0.75 * cos(theta)
    description: 'Narrowest pattern with larger rear lobe',
    color: '#FF9800', // Orange
  },
  figure8: {
    id: 'figure8',
    name: 'Figure-8',
    shortName: 'Fig-8',
    alpha: 0.0, // G = cos(theta) - can be negative!
    description: 'Front/back pickup, null at sides',
    color: '#F44336', // Red
    isBidirectional: true, // Allows negative gain (phase inversion)
  },
};

/**
 * Stereo recording technique configurations
 * All positions in meters, angles in degrees
 */
export const STEREO_TECHNIQUES = {
  'spaced-pair': {
    id: 'spaced-pair',
    name: 'Spaced Pair (AB)',
    description: 'Two parallel mics with adjustable spacing',
    micCount: 2,
    mics: [
      { id: 'L', label: 'Left', defaultAngle: 0, defaultOffsetX: -1, defaultOffsetY: 0, defaultPattern: 'omni' },
      { id: 'R', label: 'Right', defaultAngle: 0, defaultOffsetX: 1, defaultOffsetY: 0, defaultPattern: 'omni' },
    ],
    adjustable: {
      spacing: { min: 0.3, max: 6, default: 2, step: 0.1, unit: 'm', label: 'Spacing' },
      pattern: true,
      micY: true,
    },
    isCoincident: false,
    routingMode: 'direct', // L->Left, R->Right
  },

  'xy-coincident': {
    id: 'xy-coincident',
    name: 'XY Coincident',
    description: 'Two cardioids at same point, angled apart',
    micCount: 2,
    mics: [
      { id: 'L', label: 'Left', defaultAngle: -45, defaultOffsetX: 0, defaultOffsetY: 0, defaultPattern: 'cardioid' },
      { id: 'R', label: 'Right', defaultAngle: 45, defaultOffsetX: 0, defaultOffsetY: 0, defaultPattern: 'cardioid' },
    ],
    adjustable: {
      angle: { min: 60, max: 135, default: 90, step: 5, unit: '°', label: 'Angle', description: 'Total angle between mics' },
      pattern: true,
      micY: true,
    },
    isCoincident: true,
    routingMode: 'direct',
  },

  'ortf': {
    id: 'ortf',
    name: 'ORTF',
    description: 'French standard: 17cm spacing, 110° angle',
    micCount: 2,
    mics: [
      { id: 'L', label: 'Left', defaultAngle: -55, defaultOffsetX: -0.085, defaultOffsetY: 0, defaultPattern: 'cardioid' },
      { id: 'R', label: 'Right', defaultAngle: 55, defaultOffsetX: 0.085, defaultOffsetY: 0, defaultPattern: 'cardioid' },
    ],
    adjustable: {
      spacing: { min: 0.1, max: 0.4, default: 0.17, step: 0.01, unit: 'm', label: 'Spacing' },
      angle: { min: 90, max: 130, default: 110, step: 5, unit: '°', label: 'Angle' },
      pattern: true,
      micY: true,
    },
    isCoincident: false,
    routingMode: 'direct',
  },

  'blumlein': {
    id: 'blumlein',
    name: 'Blumlein Pair',
    description: 'Two figure-8 mics at 90°',
    micCount: 2,
    mics: [
      { id: 'L', label: 'Left', defaultAngle: -45, defaultOffsetX: 0, defaultOffsetY: 0, defaultPattern: 'figure8' },
      { id: 'R', label: 'Right', defaultAngle: 45, defaultOffsetX: 0, defaultOffsetY: 0, defaultPattern: 'figure8' },
    ],
    adjustable: {
      angle: { min: 60, max: 120, default: 90, step: 5, unit: '°', label: 'Angle' },
      micY: true,
      // pattern is NOT adjustable - must be figure8
    },
    isCoincident: true,
    fixedPattern: 'figure8',
    routingMode: 'direct',
  },

  'decca-tree': {
    id: 'decca-tree',
    name: 'Decca Tree',
    description: 'Classic L-C-R triangle configuration',
    micCount: 3,
    mics: [
      { id: 'L', label: 'Left', defaultAngle: 0, defaultOffsetX: -1, defaultOffsetY: 0, defaultPattern: 'omni' },
      { id: 'C', label: 'Center', defaultAngle: 0, defaultOffsetX: 0, defaultOffsetY: 1.5, defaultPattern: 'omni' },
      { id: 'R', label: 'Right', defaultAngle: 0, defaultOffsetX: 1, defaultOffsetY: 0, defaultPattern: 'omni' },
    ],
    adjustable: {
      spacing: { min: 0.5, max: 3, default: 2, step: 0.1, unit: 'm', label: 'L-R Spacing' },
      centerDepth: { min: 0.5, max: 3, default: 1.5, step: 0.1, unit: 'm', label: 'Center Depth' },
      centerLevel: { min: -12, max: 6, default: 0, step: 0.5, unit: 'dB', label: 'Center Level' },
      pattern: true,
      micY: true,
    },
    isCoincident: false,
    hasCenter: true,
    routingMode: 'decca', // L+C->Left, R+C->Right
  },
};

/**
 * Recording scenario presets
 * Pre-configured setups for common recording situations
 */
export const RECORDING_PRESETS = {
  'classical-orchestra': {
    id: 'classical-orchestra',
    name: 'Classical Orchestra',
    description: 'Decca Tree setup for full orchestra',
    technique: 'decca-tree',
    settings: {
      spacing: 2.0,
      centerDepth: 1.5,
      centerLevel: 3,
      micY: -2.0,
      pattern: 'omni',
    },
  },

  'chamber-music': {
    id: 'chamber-music',
    name: 'Chamber Music',
    description: 'ORTF for intimate ensembles',
    technique: 'ortf',
    settings: {
      spacing: 0.17,
      angle: 110,
      micY: -1.5,
      pattern: 'cardioid',
    },
  },

  'solo-piano': {
    id: 'solo-piano',
    name: 'Solo Piano',
    description: 'XY for focused, mono-compatible recording',
    technique: 'xy-coincident',
    settings: {
      angle: 90,
      micY: -1.0,
      pattern: 'cardioid',
    },
  },

  'jazz-ensemble': {
    id: 'jazz-ensemble',
    name: 'Jazz Ensemble',
    description: 'Wide spaced pair for natural sound',
    technique: 'spaced-pair',
    settings: {
      spacing: 1.5,
      micY: -1.0,
      pattern: 'omni',
    },
  },

  'choir': {
    id: 'choir',
    name: 'Choir',
    description: 'Wide Decca Tree for large vocal groups',
    technique: 'decca-tree',
    settings: {
      spacing: 3.0,
      centerDepth: 2.0,
      centerLevel: 0,
      micY: -3.0,
      pattern: 'omni',
    },
  },

  'string-quartet': {
    id: 'string-quartet',
    name: 'String Quartet',
    description: 'Blumlein for rich ambience',
    technique: 'blumlein',
    settings: {
      angle: 90,
      micY: -2.0,
    },
  },
};

/**
 * Create a microphone configuration object
 * @param {string} techniqueId - ID of stereo technique
 * @param {Object} overrides - Optional parameter overrides
 * @returns {Object} Complete microphone configuration
 */
export function createMicrophoneConfig(techniqueId = 'spaced-pair', overrides = {}) {
  const technique = STEREO_TECHNIQUES[techniqueId];
  if (!technique) {
    console.warn(`Unknown technique: ${techniqueId}, defaulting to spaced-pair`);
    return createMicrophoneConfig('spaced-pair', overrides);
  }

  // Build mic array with defaults
  const mics = technique.mics.map(m => ({
    id: m.id,
    label: m.label,
    pattern: technique.fixedPattern || m.defaultPattern,
    angle: m.defaultAngle,
    offsetX: m.defaultOffsetX,
    offsetY: m.defaultOffsetY,
    level: 0, // dB adjustment
    enabled: true,
  }));

  // Build config with technique defaults
  const config = {
    technique: techniqueId,
    micY: -1.0, // Default: 1m in front of stage

    mics,

    // Technique-specific parameters (from adjustable defaults)
    spacing: technique.adjustable.spacing?.default ?? 2,
    angle: technique.adjustable.angle?.default ?? 90,
    centerDepth: technique.adjustable.centerDepth?.default ?? 1.5,
    centerLevel: technique.adjustable.centerLevel?.default ?? 0,

    // M/S processing options
    msDecodeEnabled: false,
    msWidth: 1.0, // 0 = mono, 1 = normal, >1 = wider
  };

  // Apply overrides
  if (overrides.spacing !== undefined) config.spacing = overrides.spacing;
  if (overrides.angle !== undefined) config.angle = overrides.angle;
  if (overrides.centerDepth !== undefined) config.centerDepth = overrides.centerDepth;
  if (overrides.centerLevel !== undefined) config.centerLevel = overrides.centerLevel;
  if (overrides.micY !== undefined) config.micY = overrides.micY;
  if (overrides.pattern !== undefined && technique.adjustable.pattern) {
    config.mics.forEach(m => {
      if (!technique.fixedPattern) {
        m.pattern = overrides.pattern;
      }
    });
  }
  if (overrides.msDecodeEnabled !== undefined) config.msDecodeEnabled = overrides.msDecodeEnabled;
  if (overrides.msWidth !== undefined) config.msWidth = overrides.msWidth;

  return config;
}

/**
 * Create config from a recording preset
 * @param {string} presetId - ID of recording preset
 * @returns {Object} Complete microphone configuration
 */
export function createConfigFromPreset(presetId) {
  const preset = RECORDING_PRESETS[presetId];
  if (!preset) {
    console.warn(`Unknown preset: ${presetId}`);
    return createMicrophoneConfig();
  }

  return createMicrophoneConfig(preset.technique, preset.settings);
}

/**
 * Create a defensive copy of a mic configuration
 * @param {Object} config - Microphone configuration
 * @returns {Object} Cloned configuration
 */
export function cloneMicConfig(config) {
  if (!config) return config;

  return {
    ...config,
    mics: Array.isArray(config.mics)
      ? config.mics.map(mic => ({ ...mic }))
      : [],
  };
}

/**
 * Apply technique-specific adjustments to mic offsets
 * Call this after changing spacing/angle parameters
 * @param {Object} config - Microphone configuration
 * @returns {Object} Updated configuration
 */
export function applyTechniqueLayout(config) {
  const technique = STEREO_TECHNIQUES[config.technique];
  if (!technique) return config;

  const halfSpacing = config.spacing / 2;
  const halfAngle = config.angle / 2;

  for (const mic of config.mics) {
    const templateMic = technique.mics.find(m => m.id === mic.id);
    if (!templateMic) continue;

    // Apply spacing adjustments
    if (technique.adjustable.spacing) {
      if (mic.id === 'L') {
        mic.offsetX = -halfSpacing;
      } else if (mic.id === 'R') {
        mic.offsetX = halfSpacing;
      }
    }

    // Apply angle adjustments
    if (technique.adjustable.angle) {
      if (mic.id === 'L') {
        mic.angle = -halfAngle;
      } else if (mic.id === 'R') {
        mic.angle = halfAngle;
      }
    }

    // Apply center depth for Decca Tree
    if (mic.id === 'C' && technique.adjustable.centerDepth) {
      mic.offsetY = config.centerDepth;
      mic.level = config.centerLevel;
    }
  }

  return config;
}

/**
 * Get list of available polar patterns for a technique
 * @param {string} techniqueId - Technique ID
 * @returns {Array} Array of pattern objects
 */
export function getAvailablePatterns(techniqueId) {
  const technique = STEREO_TECHNIQUES[techniqueId];
  if (!technique) return Object.values(POLAR_PATTERNS);

  if (technique.fixedPattern) {
    return [POLAR_PATTERNS[technique.fixedPattern]];
  }

  return Object.values(POLAR_PATTERNS);
}

/**
 * Validate and clamp config values to technique limits
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validated configuration
 */
export function validateConfig(config) {
  const technique = STEREO_TECHNIQUES[config.technique];
  if (!technique) return config;

  const validated = { ...config };

  // Clamp spacing
  if (technique.adjustable.spacing) {
    const { min, max } = technique.adjustable.spacing;
    validated.spacing = Math.max(min, Math.min(max, validated.spacing));
  }

  // Clamp angle
  if (technique.adjustable.angle) {
    const { min, max } = technique.adjustable.angle;
    validated.angle = Math.max(min, Math.min(max, validated.angle));
  }

  // Clamp center depth
  if (technique.adjustable.centerDepth) {
    const { min, max } = technique.adjustable.centerDepth;
    validated.centerDepth = Math.max(min, Math.min(max, validated.centerDepth));
  }

  // Clamp center level
  if (technique.adjustable.centerLevel) {
    const { min, max } = technique.adjustable.centerLevel;
    validated.centerLevel = Math.max(min, Math.min(max, validated.centerLevel));
  }

  // Enforce fixed pattern for techniques like Blumlein
  if (technique.fixedPattern && Array.isArray(validated.mics)) {
    for (const mic of validated.mics) {
      mic.pattern = technique.fixedPattern;
    }
  }

  // Clamp micY (global limits)
  validated.micY = Math.max(-5, Math.min(-0.5, validated.micY));

  // Clamp M/S width
  validated.msWidth = Math.max(0, Math.min(2, validated.msWidth));

  return validated;
}
