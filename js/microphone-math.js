// Microphone Math - Polar pattern calculations and stereo routing
// Physics-based microphone response simulation

import { POLAR_PATTERNS, STEREO_TECHNIQUES, applyTechniqueLayout } from './microphone-types.js';

// Speed of sound at 20°C
const SPEED_OF_SOUND = 343;

/**
 * Calculate polar pattern gain for a given angle of incidence
 *
 * @param {string} patternType - Key from POLAR_PATTERNS
 * @param {number} theta - Angle in RADIANS between source direction and mic axis
 *                         0 = on-axis (front), PI = behind
 * @returns {number} Gain factor (can be negative for figure-8)
 */
export function calculatePolarGain(patternType, theta) {
  const pattern = POLAR_PATTERNS[patternType];
  if (!pattern) {
    console.warn(`Unknown polar pattern: ${patternType}, defaulting to omni`);
    return 1.0;
  }

  const alpha = pattern.alpha;

  // General polar pattern formula: G = alpha + (1 - alpha) * cos(theta)
  // Omni: alpha=1 -> G = 1
  // Cardioid: alpha=0.5 -> G = 0.5 + 0.5*cos(theta) = 0.5*(1+cos(theta))
  // Figure-8: alpha=0 -> G = cos(theta)

  const gain = alpha + (1 - alpha) * Math.cos(theta);

  // Some directional patterns (super/hypercardioid, figure-8) have rear lobes
  // with phase inversion. Preserve negative values for accurate modeling.
  return gain;
}

/**
 * Calculate the angle from a source to a microphone, accounting for mic orientation
 * Uses 3D geometry when heights are provided for consistency with ground reflections.
 *
 * @param {Object} sourcePos - {x, y} source position in meters
 * @param {Object} micPos - {x, y} mic position in meters
 * @param {number} micAngle - Mic axis angle in DEGREES (0 = facing toward stage/+Y)
 * @param {number} sourceHeight - Height of source above ground (optional)
 * @param {number} micHeight - Height of mic above ground (optional)
 * @returns {number} Angle in radians (0 = on-axis)
 */
export function calculateIncidenceAngle(sourcePos, micPos, micAngle, sourceHeight = null, micHeight = null) {
  // Direction vector from mic to source (3D if heights provided)
  const dx = sourcePos.x - micPos.x;
  const dy = sourcePos.y - micPos.y;
  const dz = (sourceHeight !== null && micHeight !== null) ? (sourceHeight - micHeight) : 0;

  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.001) {
    return 0; // On-axis by definition
  }

  // Mic axis direction (horizontal in 3D)
  // micAngle = 0 means facing +Y (toward stage)
  const micAxisRad = (90 - micAngle) * Math.PI / 180;
  const axisX = Math.cos(micAxisRad);
  const axisY = Math.sin(micAxisRad);
  const axisZ = 0;

  const cosTheta = (dx * axisX + dy * axisY + dz * axisZ) / dist;
  const clamped = Math.max(-1, Math.min(1, cosTheta));
  return Math.acos(clamped);
}

/**
 * Calculate polar pattern gain for ground reflection (mirror source)
 * Accounts for 3D incidence angle from reflected sound path
 *
 * @param {string} patternType - Key from POLAR_PATTERNS
 * @param {Object} sourcePos - {x, y} source position in meters
 * @param {Object} micPos - {x, y} mic position in meters
 * @param {number} micAngle - Mic axis angle in DEGREES (0 = facing toward stage/+Y)
 * @param {number} sourceHeight - Height of source above ground
 * @param {number} micHeight - Height of mic above ground
 * @returns {number} Polar gain for the mirror source angle
 */
export function calculateGroundReflectionPolarGain(patternType, sourcePos, micPos, micAngle, sourceHeight, micHeight) {
  const pattern = POLAR_PATTERNS[patternType];
  if (!pattern) {
    return 1.0; // Default to omni if unknown
  }

  // Mirror source position (reflected across ground plane z=0)
  // mirrorZ = -sourceHeight (below ground)
  const mirrorZ = -sourceHeight;

  // 3D direction vector from mic to mirror source
  const dx = sourcePos.x - micPos.x;
  const dy = sourcePos.y - micPos.y;
  const dz = mirrorZ - micHeight;  // Negative (mirror source is below mic)

  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.001) {
    return 1.0; // Source at mic position
  }

  // Normalize direction to mirror source
  const dirX = dx / dist;
  const dirY = dy / dist;
  const dirZ = dz / dist;

  // Mic axis direction in 3D (horizontal, based on mic angle)
  // micAngle = 0 means facing +Y (toward stage)
  // Mic axis is horizontal (z = 0)
  const micAxisRad = (90 - micAngle) * Math.PI / 180;
  const axisX = Math.cos(micAxisRad);
  const axisY = Math.sin(micAxisRad);
  const axisZ = 0;  // Mic axis is horizontal

  // 3D dot product gives cos(incidence angle)
  const cosTheta = dirX * axisX + dirY * axisY + dirZ * axisZ;
  const clamped = Math.max(-1, Math.min(1, cosTheta));

  // Apply polar pattern formula: G = alpha + (1 - alpha) * cos(theta)
  const alpha = pattern.alpha;
  return alpha + (1 - alpha) * clamped;
}

/**
 * Calculate 2D distance between two points
 * @param {Object} p1 - {x, y}
 * @param {Object} p2 - {x, y}
 * @returns {number} Distance in same units as input
 */
export function calculateDistance2D(p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculate 3D distance including height difference
 * @param {Object} source - {x, y} position
 * @param {Object} mic - {x, y} position
 * @param {number} sourceHeight - Height of source
 * @param {number} micHeight - Height of mic
 * @returns {number} 3D distance
 */
export function calculateDistance3D(source, mic, sourceHeight, micHeight) {
  const dx = mic.x - source.x;
  const dy = mic.y - source.y;
  const dz = micHeight - sourceHeight;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Calculate complete microphone response for a source
 * Combines polar pattern with distance-based attenuation
 *
 * @param {Object} sourcePos - {x, y} in meters
 * @param {Object} mic - Mic configuration object with pattern, angle, offsetX, offsetY, level
 * @param {Object} micBasePos - {x, y} base mic position in meters
 * @param {Object} options - {sourceHeight, micHeight, refDistance, minDistance}
 * @returns {Object} {gain, distance, delay, patternGain, incidenceAngle}
 */
export function calculateMicrophoneResponse(sourcePos, mic, micBasePos, options = {}) {
  const {
    sourceHeight = 1.2,
    micHeight = 1.5,
    refDistance = 3,
    minDistance = 0.3,
  } = options;

  // Calculate actual mic position with offsets
  const micPos = {
    x: micBasePos.x + (mic.offsetX || 0),
    y: micBasePos.y + (mic.offsetY || 0),
  };

  // 3D distance calculation
  const distance = calculateDistance3D(sourcePos, micPos, sourceHeight, micHeight);

  // Avoid division by zero / extreme values
  const effectiveDist = Math.max(distance, minDistance);

  // Distance-based amplitude (1/d law, normalized to reference distance)
  const distanceGain = Math.min(1.0, refDistance / effectiveDist);

  // Polar pattern gain based on incidence angle
  const incidenceAngle = calculateIncidenceAngle(sourcePos, micPos, mic.angle || 0, sourceHeight, micHeight);
  const patternGain = calculatePolarGain(mic.pattern || 'omni', incidenceAngle);

  // Level adjustment (dB to linear)
  const levelGain = Math.pow(10, (mic.level || 0) / 20);

  // Combined gain (can be negative for figure-8 rear lobes)
  const totalGain = distanceGain * patternGain * levelGain;

  // Propagation delay
  const delay = effectiveDist / SPEED_OF_SOUND;

  return {
    gain: totalGain,
    distance: effectiveDist,
    delay,
    patternGain, // For visualization/debugging
    incidenceAngle, // For visualization/debugging
  };
}

/**
 * Calculate stereo output from all mics in a technique configuration
 * Returns L/R (and optionally C) gains and delays for routing
 *
 * @param {Object} sourcePos - {x, y} normalized position (-1 to 1, 0 to 1)
 * @param {Object} config - Microphone configuration from createMicrophoneConfig
 * @param {Object} stageConfig - {width, depth, sourceHeight, micHeight}
 * @returns {Object} {left: {gain, delay}, right: {gain, delay}, center?: {...}, micResponses: {...}}
 */
export function calculateStereoResponse(sourcePos, config, stageConfig) {
  const {
    width = 20,
    depth = 15,
    sourceHeight = 1.2,
    micHeight = 1.5,
  } = stageConfig;

  // Convert normalized position to meters
  const sourcePosMeters = {
    x: sourcePos.x * (width / 2),
    y: sourcePos.y * depth,
  };

  // Apply technique layout to get current mic positions
  const layoutConfig = applyTechniqueLayout({ ...config });

  // Base mic position (all mics relative to this)
  const micBasePos = { x: 0, y: config.micY };

  const technique = STEREO_TECHNIQUES[config.technique];

  // Calculate response for each mic
  const micResponses = {};

  for (const mic of layoutConfig.mics) {
    if (!mic.enabled) continue;

    micResponses[mic.id] = calculateMicrophoneResponse(
      sourcePosMeters,
      mic,
      micBasePos,
      { sourceHeight, micHeight }
    );
  }

  // Route to stereo based on technique
  const result = routeToStereo(micResponses, layoutConfig, technique);

  // Apply M/S decoding if enabled
  if (config.msDecodeEnabled && result.left && result.right) {
    const decoded = applyMSDecode(result.left.gain, result.right.gain, config.msWidth);
    result.left.gain = decoded.left;
    result.right.gain = decoded.right;
  }

  // Include individual mic responses for advanced use
  result.micResponses = micResponses;

  return result;
}

/**
 * Route mic responses to stereo outputs based on technique
 * @param {Object} responses - Per-mic response objects
 * @param {Object} config - Mic configuration
 * @param {Object} technique - Technique definition
 * @returns {Object} {left: {gain, delay}, right: {gain, delay}, center?: {...}}
 */
function routeToStereo(responses, config, technique) {
  let left = { gain: 0, delay: 0 };
  let right = { gain: 0, delay: 0 };
  let center = null;

  if (!technique) {
    // Fallback: simple L->Left, R->Right
    if (responses.L) {
      left = { gain: responses.L.gain, delay: responses.L.delay };
    }
    if (responses.R) {
      right = { gain: responses.R.gain, delay: responses.R.delay };
    }
    return { left, right };
  }

  if (technique.routingMode === 'decca' && technique.hasCenter) {
    // Decca Tree: L + C*level -> Left, R + C*level -> Right
    // Center contributes to both channels at -3dB (equal-power pan law)
    const centerMixGain = Math.SQRT1_2; // -3dB = 1/√2 ≈ 0.707

    if (responses.L) {
      left.gain = responses.L.gain;
      left.delay = responses.L.delay;
    }
    if (responses.R) {
      right.gain = responses.R.gain;
      right.delay = responses.R.delay;
    }
    if (responses.C) {
      // Add center contribution to both channels
      left.gain += responses.C.gain * centerMixGain;
      right.gain += responses.C.gain * centerMixGain;

      // Keep L/R delays as absolute values - audio engine handles timing normalization.
      // The audio engine implements true 3-mic timing with separate delay lines
      // (delayL, delayR, delayC) each receiving baseDelay + ITD for proper arrival times.
      // Center is returned here for the audio engine to process independently.

      center = { gain: responses.C.gain, delay: responses.C.delay };
    }
  } else {
    // Standard: L -> Left, R -> Right
    if (responses.L) {
      left = { gain: responses.L.gain, delay: responses.L.delay };
    }
    if (responses.R) {
      right = { gain: responses.R.gain, delay: responses.R.delay };
    }
  }

  return { left, right, center };
}

/**
 * Apply M/S (Mid-Side) decode processing to stereo signals
 * Mid = (L + R) / 2, Side = (L - R) / 2
 * Output: L = Mid + width*Side, R = Mid - width*Side
 *
 * @param {number} leftGain - Left channel gain
 * @param {number} rightGain - Right channel gain
 * @param {number} width - Width control (0=mono, 1=normal, 2=extra wide)
 * @returns {Object} {left, right} decoded gains
 */
function applyMSDecode(leftGain, rightGain, width) {
  const mid = (leftGain + rightGain) / 2;
  const side = (leftGain - rightGain) / 2;

  return {
    left: mid + width * side,
    right: mid - width * side,
  };
}

/**
 * Calculate polar pattern points for visualization
 * Returns array of {x, y} points normalized to unit circle
 *
 * @param {string} patternType - Pattern type ID
 * @param {number} steps - Number of points to generate
 * @returns {Array} Array of {x, y, gain} points
 */
export function getPolarPatternPoints(patternType, steps = 72) {
  const points = [];

  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    const gain = calculatePolarGain(patternType, theta);

    // For figure-8, we need to handle negative lobes
    const r = Math.abs(gain);
    const isNegative = gain < 0;

    // Point on the polar curve
    // theta=0 is front (facing +Y in our convention), so adjust for drawing
    // In SVG/Canvas: 0° is +X axis, going clockwise
    // We want 0° to be up (+Y visual), so rotate by -90°
    const drawAngle = theta - Math.PI / 2;

    points.push({
      x: r * Math.cos(drawAngle),
      y: r * Math.sin(drawAngle),
      gain,
      isNegative,
      angle: theta,
    });
  }

  return points;
}

/**
 * Get the characteristic angles for a polar pattern
 * (null angle for figure-8 sides, rear rejection, etc.)
 *
 * @param {string} patternType - Pattern type ID
 * @returns {Object} {nullAngles, maxRejection, acceptanceAngle}
 */
export function getPatternCharacteristics(patternType) {
  const pattern = POLAR_PATTERNS[patternType];
  if (!pattern) return null;

  const alpha = pattern.alpha;

  // Find null angles (where gain = 0)
  // 0 = alpha + (1-alpha)*cos(theta)
  // cos(theta) = -alpha / (1-alpha)
  const nullAngles = [];

  if (alpha < 1) {
    const cosNull = -alpha / (1 - alpha);
    if (cosNull >= -1 && cosNull <= 1) {
      const nullAngle = Math.acos(cosNull) * 180 / Math.PI;
      nullAngles.push(nullAngle);
      nullAngles.push(360 - nullAngle);
    }
  }

  // Rear rejection (gain at 180°)
  const rearGain = calculatePolarGain(patternType, Math.PI);
  const rearRejectionDb = rearGain === 0 ? -Infinity : 20 * Math.log10(Math.abs(rearGain));

  // -3dB acceptance angle (where gain drops to 0.707)
  let acceptanceAngle = 180; // Default for omni
  if (alpha < 1) {
    // 0.707 = alpha + (1-alpha)*cos(theta)
    // cos(theta) = (0.707 - alpha) / (1-alpha)
    const cos3dB = (0.707 - alpha) / (1 - alpha);
    if (cos3dB >= -1 && cos3dB <= 1) {
      acceptanceAngle = Math.acos(cos3dB) * 180 / Math.PI * 2; // Full angle
    }
  }

  return {
    nullAngles,
    rearRejectionDb,
    acceptanceAngle,
    isBidirectional: pattern.isBidirectional || false,
  };
}

/**
 * Calculate ITD (Interaural Time Difference) in milliseconds
 * Useful for psychoacoustic analysis
 *
 * @param {number} delayL - Left channel delay in seconds
 * @param {number} delayR - Right channel delay in seconds
 * @returns {number} ITD in milliseconds (positive = right leads)
 */
export function calculateITD(delayL, delayR) {
  return (delayL - delayR) * 1000;
}

/**
 * Calculate ILD (Interaural Level Difference) in dB
 *
 * @param {number} gainL - Left channel gain (linear)
 * @param {number} gainR - Right channel gain (linear)
 * @returns {number} ILD in dB (positive = right louder)
 */
export function calculateILD(gainL, gainR) {
  if (gainL === 0 && gainR === 0) return 0;
  if (gainL === 0) return Infinity;
  if (gainR === 0) return -Infinity;

  return 20 * Math.log10(Math.abs(gainR) / Math.abs(gainL));
}
