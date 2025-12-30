// Web Audio API engine with physically accurate stereo simulation
// Features: ITD, 1/d amplitude, frequency-dependent air absorption, optional ground reflection
// Microphone modeling: polar patterns, stereo techniques (AB, XY, ORTF, Blumlein, Decca Tree)

import {
  createMicrophoneConfig,
  createConfigFromPreset,
  applyTechniqueLayout,
  validateConfig,
  STEREO_TECHNIQUES,
  POLAR_PATTERNS,
  RECORDING_PRESETS,
} from './microphone-types.js';

import {
  calculateStereoResponse,
  calculatePolarGain,
  getPolarPatternPoints,
} from './microphone-math.js';

// Physical constants
const SPEED_OF_SOUND = 343; // m/s at 20°C

// Air absorption coefficients in dB per 100 meters at different frequencies
// Based on ISO 9613-1 at 20°C, 50% relative humidity
// Used for frequency-dependent high-frequency rolloff simulation
const AIR_ABSORPTION = [
  { freq: 250, alpha: 0.1 },
  { freq: 500, alpha: 0.3 },
  { freq: 1000, alpha: 0.6 },
  { freq: 2000, alpha: 1.3 },
  { freq: 4000, alpha: 2.8 },
  { freq: 8000, alpha: 7.0 },
  { freq: 16000, alpha: 22.0 },
];

// Stage dimensions (meters)
const STAGE_CONFIG = {
  width: 20,        // -10m to +10m
  depth: 15,        // 0 to 15m from audience
  micSpacing: 2,    // 2m between L and R mics
  micY: -1,         // Mics are 1m in front of stage edge (in audience)
  sourceHeight: 1.2, // Average instrument height
  micHeight: 1.5,   // Mic/ear height
  groundReflectionCoeff: 0.7, // Ground absorption (0=absorptive, 1=reflective)
};

const CENTER_PAN_GAIN = Math.SQRT1_2; // -3dB equal-power pan for center mic

// Approximate ground reflection models (frequency-dependent phase/level)
// lowGain/highGain are relative band gains; negative = phase inversion.
const GROUND_REFLECTION_MODELS = {
  hard: { id: 'hard', label: 'Hard (rigid)', lowGain: 1.0, highGain: 0.9, crossoverHz: 800 },
  stage: { id: 'stage', label: 'Stage (wood)', lowGain: -0.7, highGain: 0.5, crossoverHz: 500 },
  soft: { id: 'soft', label: 'Soft (absorptive)', lowGain: -0.4, highGain: 0.2, crossoverHz: 300 },
};

const DEFAULT_GROUND_REFLECTION_MODEL = 'stage';

export class AudioEngine {
  constructor() {
    this.context = null;
    this.masterGainNode = null;
    this.reverbNode = null;
    this.reverbGainNode = null;

    this.trackNodes = new Map(); // trackId -> { sourceL, sourceR, ... }
    this.tracks = new Map(); // trackId -> track data

    this.isPlaying = false;
    this.startTime = 0;
    this.pauseOffset = 0;
    this.duration = 0;

    this.masterGain = 0.8;
    this.reverbPreset = 'concert-hall';
    this.reverbMode = 'depth'; // 'depth' or 'uniform'
    this.reverbMix = 0.3;
    this.groundReflectionEnabled = false;
    this.groundReflectionModel = DEFAULT_GROUND_REFLECTION_MODEL;

    this.onTimeUpdate = null;
    this.onPlaybackEnd = null;
    this.animationFrame = null;

    // Microphone configuration (techniques, polar patterns, positions)
    this.micConfig = createMicrophoneConfig('spaced-pair');

    // Legacy mic positions (derived from micConfig for backward compatibility)
    this.micL = { x: -STAGE_CONFIG.micSpacing / 2, y: STAGE_CONFIG.micY };
    this.micR = { x: STAGE_CONFIG.micSpacing / 2, y: STAGE_CONFIG.micY };
    this.micC = null;
    this._updateLegacyMicPositions();
  }

  /**
   * Update legacy mic positions from current micConfig
   * Used for backward compatibility with existing code
   */
  _updateLegacyMicPositions() {
    const layoutConfig = applyTechniqueLayout({ ...this.micConfig });
    const baseY = this.micConfig.micY;

    // Find L, R, and C mics
    const micL = layoutConfig.mics.find(m => m.id === 'L');
    const micR = layoutConfig.mics.find(m => m.id === 'R');
    const micC = layoutConfig.mics.find(m => m.id === 'C');

    if (micL) {
      this.micL = { x: micL.offsetX, y: baseY + (micL.offsetY || 0) };
    }
    if (micR) {
      this.micR = { x: micR.offsetX, y: baseY + (micR.offsetY || 0) };
    }
    if (micC) {
      this.micC = { x: micC.offsetX, y: baseY + (micC.offsetY || 0) };
    } else {
      this.micC = null;
    }
  }

  /**
   * Initialize the audio context
   */
  async init() {
    if (this.context) return;

    this.context = new (window.AudioContext || window.webkitAudioContext)();

    // Create master limiter to prevent clipping
    // Acts as a transparent brickwall limiter at -1dB
    this.masterLimiter = this.context.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -1;    // Start limiting at -1dB (near 0dBFS)
    this.masterLimiter.knee.value = 0;          // Hard knee for brickwall behavior
    this.masterLimiter.ratio.value = 20;        // Near-infinite ratio
    this.masterLimiter.attack.value = 0.001;    // 1ms attack (fast)
    this.masterLimiter.release.value = 0.05;    // 50ms release
    this.masterLimiter.connect(this.context.destination);

    // Create master output chain
    this.masterGainNode = this.context.createGain();
    this.masterGainNode.gain.value = this.masterGain;
    this.masterGainNode.connect(this.masterLimiter);

    // Create stereo merger for final L/R output
    this.stereoMerger = this.context.createChannelMerger(2);
    this.stereoMerger.connect(this.masterGainNode);

    // Create reverb chain
    this.reverbGainNode = this.context.createGain();
    this.reverbGainNode.gain.value = this.reverbMix;
    this.reverbGainNode.connect(this.masterGainNode);

    this.reverbNode = this.context.createConvolver();
    this.reverbNode.connect(this.reverbGainNode);
  }

  /**
   * Resume audio context if suspended
   */
  async resume() {
    if (this.context && this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  /**
   * Decode audio data
   */
  async decodeAudio(arrayBuffer) {
    await this.init();
    return await this.context.decodeAudioData(arrayBuffer);
  }

  /**
   * Convert normalized coordinates to meters
   * @param {number} x - Normalized X (-1 to 1)
   * @param {number} y - Normalized Y (0 to 1)
   * @returns {{x: number, y: number}} - Position in meters
   */
  normalizedToMeters(x, y) {
    return {
      x: x * (STAGE_CONFIG.width / 2),
      y: y * STAGE_CONFIG.depth,
    };
  }

  /**
   * Calculate 3D distance including height difference
   */
  calculateDistance3D(source, mic, sourceHeight, micHeight) {
    const dx = mic.x - source.x;
    const dy = mic.y - source.y;
    const dz = micHeight - sourceHeight;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Calculate ground reflection path length
   * Sound travels down to ground, reflects, then up to mic
   */
  calculateGroundReflectionDistance(source, mic, sourceHeight, micHeight) {
    const dx = mic.x - source.x;
    const dy = mic.y - source.y;
    const horizontalDist = Math.sqrt(dx * dx + dy * dy);

    // Reflection point is where the angles are equal (mirror image)
    // Total vertical travel = sourceHeight + micHeight
    const totalVertical = sourceHeight + micHeight;

    return Math.sqrt(horizontalDist * horizontalDist + totalVertical * totalVertical);
  }

  /**
   * Calculate directivity blend factor for a mic position
   * Instruments face toward audience (negative Y direction)
   * Returns { front: 0-1, bell: 0-1 } blend weights
   */
  calculateDirectivityBlend(sourcePos, micPos) {
    // Instrument facing direction (toward audience, negative Y)
    const facingX = 0;
    const facingY = -1;

    // Direction from source to mic
    const toMicX = micPos.x - sourcePos.x;
    const toMicY = micPos.y - sourcePos.y;
    const toMicLen = Math.sqrt(toMicX * toMicX + toMicY * toMicY);

    if (toMicLen < 0.01) {
      return { front: 1, bell: 0 };
    }

    // Normalize
    const normToMicX = toMicX / toMicLen;
    const normToMicY = toMicY / toMicLen;

    // Dot product: cos(angle) between facing direction and direction to mic
    // +1 = mic is in front (facing direction), -1 = mic is behind
    const cosAngle = facingX * normToMicX + facingY * normToMicY;

    // Convert to blend weights:
    // cosAngle = 1 (front) → front=1, bell=0
    // cosAngle = -1 (behind) → front=0, bell=1
    // Using smooth blend: front = (1 + cosAngle) / 2
    const frontWeight = (1 + cosAngle) / 2;
    const bellWeight = 1 - frontWeight;

    return { front: frontWeight, bell: bellWeight };
  }

  /**
   * Add a track to the engine
   */
  addTrack(id, buffer, options = {}) {
    const track = {
      id,
      buffer,
      x: options.x ?? 0,
      y: options.y ?? 0.1,
      gain: options.gain ?? 1,
      muted: options.muted ?? false,
      solo: options.solo ?? false,
      // Directivity: front mic (6) and bell mic (8) for blending
      directivityBuffers: options.directivityBuffers ?? null,
      frontBuffer: null,
      bellBuffer: null,
    };

    // Extract front (mic 6) and bell (mic 8) buffers for directivity
    if (track.directivityBuffers && track.directivityBuffers.size > 1) {
      track.frontBuffer = track.directivityBuffers.get('6') || buffer;
      track.bellBuffer = track.directivityBuffers.get('8') || null;
    }

    this.tracks.set(id, track);

    if (buffer.duration > this.duration) {
      this.duration = buffer.duration;
    }
  }

  /**
   * Remove a track
   */
  removeTrack(id) {
    this.disconnectTrack(id);
    this.tracks.delete(id);
    this.recalculateDuration();
  }

  /**
   * Clear all tracks
   */
  clearTracks() {
    this.stop();
    for (const id of this.tracks.keys()) {
      this.disconnectTrack(id);
    }
    this.tracks.clear();
    this.duration = 0;
  }

  /**
   * Recalculate total duration
   */
  recalculateDuration() {
    this.duration = 0;
    for (const track of this.tracks.values()) {
      if (track.buffer.duration > this.duration) {
        this.duration = track.buffer.duration;
      }
    }
  }

  /**
   * Set ground reflection enabled
   */
  setGroundReflection(enabled) {
    this.groundReflectionEnabled = enabled;

    // If playing, need to rebuild audio graph
    if (this.isPlaying) {
      const currentTime = this.getCurrentTime();
      this.stop(false);
      this.pauseOffset = currentTime;
      this.play();
    }
  }

  /**
   * Set ground reflection model (frequency-dependent phase/level)
   * @param {string} modelId - Model ID from GROUND_REFLECTION_MODELS
   */
  setGroundReflectionModel(modelId) {
    if (!GROUND_REFLECTION_MODELS[modelId]) {
      console.warn(`Unknown ground reflection model: ${modelId}`);
      return;
    }

    this.groundReflectionModel = modelId;
    this._updateAllTracks();
  }

  /**
   * Get ground reflection model ID
   */
  getGroundReflectionModel() {
    return this.groundReflectionModel;
  }

  /**
   * Get current ground reflection model config
   */
  getGroundReflectionModelConfig() {
    return GROUND_REFLECTION_MODELS[this.groundReflectionModel] || GROUND_REFLECTION_MODELS[DEFAULT_GROUND_REFLECTION_MODEL];
  }

  /**
   * Set mic separation (DECCA-style, tied on Y axis)
   * @param {number} separation - Total separation in meters (L and R are ±separation/2 from center)
   */
  setMicSeparation(separation) {
    this.micConfig.spacing = separation;
    this.micConfig = validateConfig(this.micConfig);
    this._updateLegacyMicPositions();
    this._updateAllTracks();
  }

  /**
   * Get current mic separation
   */
  getMicSeparation() {
    return this.micConfig.spacing;
  }

  /**
   * Set mic Y position (distance from stage)
   * @param {number} micY - Y position in meters (negative = in audience)
   */
  setMicY(micY) {
    this.micConfig.micY = micY;
    this.micConfig = validateConfig(this.micConfig);
    this._updateLegacyMicPositions();
    this._updateAllTracks();
  }

  /**
   * Get current mic Y position
   */
  getMicY() {
    return this.micConfig.micY;
  }

  /**
   * Set stereo recording technique
   * @param {string} techniqueId - Technique ID (spaced-pair, xy-coincident, ortf, blumlein, decca-tree)
   */
  setTechnique(techniqueId) {
    const oldConfig = this.micConfig;
    this.micConfig = createMicrophoneConfig(techniqueId, {
      spacing: oldConfig.spacing,
      micY: oldConfig.micY,
      msDecodeEnabled: oldConfig.msDecodeEnabled,
      msWidth: oldConfig.msWidth,
    });
    this._updateLegacyMicPositions();

    // Rebuild audio graph if playing (technique change may add/remove center mic)
    if (this.isPlaying) {
      const currentTime = this.getCurrentTime();
      this.stop(false);
      this.pauseOffset = currentTime;
      this.play();
    } else {
      this._updateAllTracks();
    }
  }

  /**
   * Get current technique ID
   */
  getTechnique() {
    return this.micConfig.technique;
  }

  /**
   * Set mic angle (for angled techniques like XY, ORTF, Blumlein)
   * @param {number} angle - Total angle in degrees
   */
  setMicAngle(angle) {
    this.micConfig.angle = angle;
    this.micConfig = validateConfig(this.micConfig);
    this._updateLegacyMicPositions();
    this._updateAllTracks();
  }

  /**
   * Get current mic angle
   */
  getMicAngle() {
    return this.micConfig.angle;
  }

  /**
   * Set polar pattern for all mics (or specific mic)
   * @param {string} pattern - Pattern ID (omni, cardioid, supercardioid, hypercardioid, figure8)
   * @param {string} micId - Optional specific mic ID (L, R, C)
   */
  setMicPattern(pattern, micId = null) {
    const technique = STEREO_TECHNIQUES[this.micConfig.technique];

    // Check if pattern can be changed
    if (technique?.fixedPattern) {
      console.warn(`Cannot change pattern for ${this.micConfig.technique} - fixed to ${technique.fixedPattern}`);
      return;
    }

    if (micId) {
      // Set specific mic
      const mic = this.micConfig.mics.find(m => m.id === micId);
      if (mic) {
        mic.pattern = pattern;
      }
    } else {
      // Set all mics
      for (const mic of this.micConfig.mics) {
        mic.pattern = pattern;
      }
    }

    this._updateAllTracks();
  }

  /**
   * Get polar pattern for a mic
   * @param {string} micId - Mic ID (L, R, C)
   */
  getMicPattern(micId = 'L') {
    const mic = this.micConfig.mics.find(m => m.id === micId);
    return mic?.pattern || 'omni';
  }

  /**
   * Set center mic level (for Decca Tree)
   * @param {number} level - Level in dB
   */
  setCenterLevel(level) {
    this.micConfig.centerLevel = level;
    this.micConfig = validateConfig(this.micConfig);
    this._updateAllTracks();
  }

  /**
   * Get center mic level
   */
  getCenterLevel() {
    return this.micConfig.centerLevel;
  }

  /**
   * Set center mic depth (for Decca Tree)
   * @param {number} depth - Depth in meters
   */
  setCenterDepth(depth) {
    this.micConfig.centerDepth = depth;
    this.micConfig = validateConfig(this.micConfig);
    this._updateLegacyMicPositions();
    this._updateAllTracks();
  }

  /**
   * Get center mic depth
   */
  getCenterDepth() {
    return this.micConfig.centerDepth;
  }

  /**
   * Enable/disable M/S decode processing
   * @param {boolean} enabled
   */
  setMSDecodeEnabled(enabled) {
    this.micConfig.msDecodeEnabled = enabled;
    this._updateAllTracks();
  }

  /**
   * Get M/S decode enabled state
   */
  getMSDecodeEnabled() {
    return this.micConfig.msDecodeEnabled;
  }

  /**
   * Set M/S decode width
   * @param {number} width - 0=mono, 1=normal, 2=extra wide
   */
  setMSWidth(width) {
    this.micConfig.msWidth = width;
    this.micConfig = validateConfig(this.micConfig);
    this._updateAllTracks();
  }

  /**
   * Get M/S decode width
   */
  getMSWidth() {
    return this.micConfig.msWidth;
  }

  /**
   * Apply a recording preset
   * @param {string} presetId - Preset ID
   */
  applyPreset(presetId) {
    this.micConfig = createConfigFromPreset(presetId);
    this._updateLegacyMicPositions();

    // Rebuild audio graph if playing
    if (this.isPlaying) {
      const currentTime = this.getCurrentTime();
      this.stop(false);
      this.pauseOffset = currentTime;
      this.play();
    } else {
      this._updateAllTracks();
    }
  }

  /**
   * Get current microphone configuration
   */
  getMicConfig() {
    return { ...this.micConfig };
  }

  /**
   * Set full microphone configuration
   * @param {Object} config - Configuration object
   */
  setMicConfig(config) {
    this.micConfig = validateConfig({ ...config });
    this._updateLegacyMicPositions();

    // Rebuild audio graph if playing (technique may have changed)
    if (this.isPlaying) {
      const currentTime = this.getCurrentTime();
      this.stop(false);
      this.pauseOffset = currentTime;
      this.play();
    } else {
      this._updateAllTracks();
    }
  }

  /**
   * Update all track audio params
   */
  _updateAllTracks() {
    for (const [id, track] of this.tracks) {
      const nodes = this.trackNodes.get(id);
      if (nodes) {
        this.updateTrackAudioParams(id, track, nodes);
      }
    }
  }

  /**
   * Update track position
   */
  updateTrackPosition(id, x, y) {
    const track = this.tracks.get(id);
    if (!track) return;

    track.x = x;
    track.y = y;

    const nodes = this.trackNodes.get(id);
    if (nodes) {
      this.updateTrackAudioParams(id, track, nodes);
    }
  }

  /**
   * Update audio parameters for a track based on position
   * Uses polar pattern aware stereo response calculation
   */
  updateTrackAudioParams(id, track, nodes) {
    const sourcePos = { x: track.x, y: track.y }; // Normalized position
    const sourcePosMeters = this.normalizedToMeters(track.x, track.y);

    // Calculate stereo response using new microphone simulation
    // This includes polar pattern gain, distance attenuation, and delays
    const stereoResponse = calculateStereoResponse(sourcePos, this.micConfig, STAGE_CONFIG);

    const micResponses = stereoResponse.micResponses || {};
    const hasCenter = !!nodes.hasCenter;

    // Extract L/R gains (includes polar pattern and 1/d attenuation)
    // Preserve sign for rear lobes - negative gain inverts phase via GainNode
    const responseL = micResponses.L;
    const responseR = micResponses.R;
    const responseC = hasCenter ? micResponses.C : null;

    const ampL = hasCenter && responseL ? responseL.gain : stereoResponse.left.gain;
    const ampR = hasCenter && responseR ? responseR.gain : stereoResponse.right.gain;
    const ampC = responseC ? responseC.gain : 0;

    // Track distances for air absorption (from mic responses)
    const effectiveDistL = responseL?.distance || 3;
    const effectiveDistR = responseR?.distance || 3;
    const effectiveDistC = responseC?.distance || 3;

    // Apply track gain and mute/solo
    const hasSolo = Array.from(this.tracks.values()).some(t => t.solo);
    const groundModel = this.groundReflectionEnabled ? this.getGroundReflectionModelConfig() : null;
    let gainMultiplier = track.gain;
    if (track.muted || (hasSolo && !track.solo)) {
      gainMultiplier = 0;
    }

    // === INSTRUMENT DIRECTIVITY BLENDING ===
    // This is separate from mic polar patterns - it's the instrument radiation pattern
    // (blending between front mic 6 and bell mic 8 recordings)
    const blendL = this.calculateDirectivityBlend(sourcePosMeters, this.micL);
    const blendR = this.calculateDirectivityBlend(sourcePosMeters, this.micR);
    const blendC = (hasCenter && this.micC)
      ? this.calculateDirectivityBlend(sourcePosMeters, this.micC)
      : { front: 1, bell: 0 };

    // Use setTargetAtTime for smooth transitions to avoid zipper noise during dragging
    const now = this.context.currentTime;
    const rampTime = 0.02; // 20ms ramp for smooth transitions

    if (nodes.hasDirectivity) {
      // Apply directivity: front and bell sources are blended per channel
      // Mic polar pattern gain (ampL/ampR) combined with instrument directivity (blendL/blendR)
      nodes.frontGainL.gain.setTargetAtTime(ampL * gainMultiplier * blendL.front, now, rampTime);
      nodes.frontGainR.gain.setTargetAtTime(ampR * gainMultiplier * blendR.front, now, rampTime);
      nodes.bellGainL.gain.setTargetAtTime(ampL * gainMultiplier * blendL.bell, now, rampTime);
      nodes.bellGainR.gain.setTargetAtTime(ampR * gainMultiplier * blendR.bell, now, rampTime);
      if (nodes.frontGainC) {
        nodes.frontGainC.gain.setTargetAtTime(ampC * gainMultiplier * blendC.front, now, rampTime);
      }
      if (nodes.bellGainC) {
        nodes.bellGainC.gain.setTargetAtTime(ampC * gainMultiplier * blendC.bell, now, rampTime);
      }
    } else {
      // No instrument directivity: apply mic polar pattern gain directly
      nodes.frontGainL.gain.setTargetAtTime(ampL * gainMultiplier, now, rampTime);
      nodes.frontGainR.gain.setTargetAtTime(ampR * gainMultiplier, now, rampTime);
      if (nodes.frontGainC) {
        nodes.frontGainC.gain.setTargetAtTime(ampC * gainMultiplier, now, rampTime);
      }
    }

    // === DELAYS (ITD) ===
    // Use delays from stereo response
    const delayL = responseL?.delay ?? stereoResponse.left.delay;
    const delayR = responseR?.delay ?? stereoResponse.right.delay;
    const delayC = responseC?.delay ?? null;

    // Base delay: average propagation time preserves depth timing cues
    const refDistance = Math.abs(this.micConfig.micY);
    const refTime = refDistance / SPEED_OF_SOUND;
    const avgTime = (delayL + delayR) / 2;
    const baseDelay = Math.max(0, avgTime - refTime);

    // ITD: additional delay for the further channel
    const minTime = (hasCenter && delayC !== null) ? Math.min(delayL, delayR, delayC) : Math.min(delayL, delayR);
    const itdL = delayL - minTime;
    const itdR = delayR - minTime;
    const itdC = (hasCenter && delayC !== null) ? delayC - minTime : 0;

    nodes.delayL.delayTime.setTargetAtTime(baseDelay + itdL, now, rampTime);
    nodes.delayR.delayTime.setTargetAtTime(baseDelay + itdR, now, rampTime);
    if (nodes.delayC) {
      nodes.delayC.delayTime.setTargetAtTime(baseDelay + itdC, now, rampTime);
    }

    // Air absorption - update filter banks (ISO 9613-1 frequency-dependent)
    this.updateAirAbsorptionFilters(nodes.airAbsorbL, effectiveDistL, now, rampTime);
    this.updateAirAbsorptionFilters(nodes.airAbsorbR, effectiveDistR, now, rampTime);
    if (nodes.airAbsorbC) {
      this.updateAirAbsorptionFilters(nodes.airAbsorbC, effectiveDistC, now, rampTime);
    }

    // Ground reflection (if enabled and nodes exist)
    if (nodes.groundDelayL && nodes.groundBaseGainL) {
      if (this.groundReflectionEnabled) {
        const groundModel = this.getGroundReflectionModelConfig();
        const lowGain = groundModel.lowGain * STAGE_CONFIG.groundReflectionCoeff;
        const highGain = groundModel.highGain * STAGE_CONFIG.groundReflectionCoeff;
        const crossFreq = groundModel.crossoverHz;

        // Use meters coordinates for distance calculation
        const groundDistL = this.calculateGroundReflectionDistance(
          sourcePosMeters, this.micL, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );
        const groundDistR = this.calculateGroundReflectionDistance(
          sourcePosMeters, this.micR, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );

        const groundTimeL = groundDistL / SPEED_OF_SOUND;
        const groundTimeR = groundDistR / SPEED_OF_SOUND;

        // Reference distance for amplitude calculation
        const refDist = 3;

        // Ground reflection delay must include baseDelay + ITD so it arrives AFTER direct sound
        // Direct sound uses: baseDelay + itdL/itdR
        // Ground reflection is extra path time (groundTime - directTime) on top of that
        const groundExtraL = Math.max(0, groundTimeL - delayL);
        const groundExtraR = Math.max(0, groundTimeR - delayR);
        nodes.groundDelayL.delayTime.setTargetAtTime(baseDelay + itdL + groundExtraL, now, rampTime);
        nodes.groundDelayR.delayTime.setTargetAtTime(baseDelay + itdR + groundExtraR, now, rampTime);

        const baseAmpL = Math.min(1.0, refDist / groundDistL) * gainMultiplier;
        const baseAmpR = Math.min(1.0, refDist / groundDistR) * gainMultiplier;
        nodes.groundBaseGainL.gain.setTargetAtTime(baseAmpL, now, rampTime);
        nodes.groundBaseGainR.gain.setTargetAtTime(baseAmpR, now, rampTime);

        nodes.groundLowGainL.gain.setTargetAtTime(lowGain, now, rampTime);
        nodes.groundHighGainL.gain.setTargetAtTime(highGain, now, rampTime);
        nodes.groundLowGainR.gain.setTargetAtTime(lowGain, now, rampTime);
        nodes.groundHighGainR.gain.setTargetAtTime(highGain, now, rampTime);

        nodes.groundLowFilterL.frequency.setTargetAtTime(crossFreq, now, rampTime);
        nodes.groundHighFilterL.frequency.setTargetAtTime(crossFreq, now, rampTime);
        nodes.groundLowFilterR.frequency.setTargetAtTime(crossFreq, now, rampTime);
        nodes.groundHighFilterR.frequency.setTargetAtTime(crossFreq, now, rampTime);

        if (nodes.groundDelayC && nodes.groundBaseGainC && this.micC && delayC !== null) {
          const groundDistC = this.calculateGroundReflectionDistance(
            sourcePosMeters, this.micC, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
          );
          const groundTimeC = groundDistC / SPEED_OF_SOUND;
          const groundExtraC = Math.max(0, groundTimeC - delayC);
          const baseAmpC = Math.min(1.0, refDist / groundDistC) * gainMultiplier;

          nodes.groundDelayC.delayTime.setTargetAtTime(baseDelay + itdC + groundExtraC, now, rampTime);
          nodes.groundBaseGainC.gain.setTargetAtTime(baseAmpC, now, rampTime);
          nodes.groundLowGainC.gain.setTargetAtTime(lowGain, now, rampTime);
          nodes.groundHighGainC.gain.setTargetAtTime(highGain, now, rampTime);
          nodes.groundLowFilterC.frequency.setTargetAtTime(crossFreq, now, rampTime);
          nodes.groundHighFilterC.frequency.setTargetAtTime(crossFreq, now, rampTime);
        }
      } else {
        nodes.groundBaseGainL.gain.setTargetAtTime(0, now, rampTime);
        nodes.groundBaseGainR.gain.setTargetAtTime(0, now, rampTime);
        if (nodes.groundBaseGainC) {
          nodes.groundBaseGainC.gain.setTargetAtTime(0, now, rampTime);
        }
      }
    }

    // Reverb send based on mode (stereo - L and R have same level)
    if (nodes.reverbSendL && nodes.reverbSendR) {
      const reverbLevel = this.calculateReverbSend(track.y);
      nodes.reverbSendL.gain.setTargetAtTime(reverbLevel, now, rampTime);
      nodes.reverbSendR.gain.setTargetAtTime(reverbLevel, now, rampTime);
      if (nodes.reverbSendC) {
        nodes.reverbSendC.gain.setTargetAtTime(reverbLevel * CENTER_PAN_GAIN, now, rampTime);
      }
    }
  }

  /**
   * Calculate air absorption in dB for each frequency band (ISO 9613-1)
   * @param {number} distance - Distance in meters
   * @returns {Array} - Array of {freq, gainDb} for each band
   */
  calculateAirAbsorption(distance) {
    return AIR_ABSORPTION.map(({ freq, alpha }) => ({
      freq,
      gainDb: -(alpha * distance) / 100, // Negative because it's attenuation
    }));
  }

  /**
   * Create a filter bank for frequency-dependent air absorption
   * Uses peaking filters at ISO 9613-1 frequency bands
   * @param {AudioContext} ctx - Audio context to use
   * @returns {Array} - Array of BiquadFilterNode
   */
  createAirAbsorptionFilterBank(ctx) {
    return AIR_ABSORPTION.map(({ freq }) => {
      const filter = ctx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      // Q factor chosen to give roughly octave-wide bands
      filter.Q.value = 1.4;
      filter.gain.value = 0;
      return filter;
    });
  }

  /**
   * Update air absorption filter bank gains based on distance
   * @param {Array} filters - Array of BiquadFilterNode
   * @param {number} distance - Distance in meters
   * @param {number} now - Current audio context time
   * @param {number} rampTime - Time constant for smooth transition
   */
  updateAirAbsorptionFilters(filters, distance, now, rampTime) {
    const absorption = this.calculateAirAbsorption(distance);
    filters.forEach((filter, i) => {
      filter.gain.setTargetAtTime(absorption[i].gainDb, now, rampTime);
    });
  }

  /**
   * Update track gain
   */
  updateTrackGain(id, gain) {
    const track = this.tracks.get(id);
    if (!track) return;

    track.gain = gain;

    const nodes = this.trackNodes.get(id);
    if (nodes) {
      this.updateTrackAudioParams(id, track, nodes);
    }
  }

  /**
   * Update track mute state
   */
  updateTrackMuted(id, muted) {
    const track = this.tracks.get(id);
    if (!track) return;

    track.muted = muted;

    const nodes = this.trackNodes.get(id);
    if (nodes) {
      this.updateTrackAudioParams(id, track, nodes);
    }
  }

  /**
   * Update track solo state
   */
  updateTrackSolo(id, solo) {
    const track = this.tracks.get(id);
    if (!track) return;

    track.solo = solo;

    // Update all tracks since solo affects others
    for (const [trackId, trackData] of this.tracks) {
      const nodes = this.trackNodes.get(trackId);
      if (nodes) {
        this.updateTrackAudioParams(trackId, trackData, nodes);
      }
    }
  }

  /**
   * Update track audio buffer (for noise gate re-processing)
   */
  updateTrackBuffer(id, newBuffer) {
    const track = this.tracks.get(id);
    if (!track) return;

    track.buffer = newBuffer;

    // Update duration if needed
    if (newBuffer.duration > this.duration) {
      this.duration = newBuffer.duration;
    }

    // If playing, reconnect with new buffer
    if (this.isPlaying) {
      const currentTime = this.getCurrentTime();
      this.disconnectTrack(id);
      this.connectTrack(id, currentTime);
    }
  }

  /**
   * Update track directivity buffers (for noise gate re-processing)
   */
  updateTrackDirectivityBuffers(id, alternateBuffers) {
    const track = this.tracks.get(id);
    if (!track) return;

    track.directivityBuffers = alternateBuffers;

    // Update front/bell buffers for directivity
    if (alternateBuffers && alternateBuffers.size > 1) {
      track.frontBuffer = alternateBuffers.get('6') || track.buffer;
      track.bellBuffer = alternateBuffers.get('8') || null;
    } else {
      track.frontBuffer = null;
      track.bellBuffer = null;
    }

    // If playing, reconnect with new buffers
    if (this.isPlaying) {
      const currentTime = this.getCurrentTime();
      this.disconnectTrack(id);
      this.connectTrack(id, currentTime);
    }
  }

  /**
   * Set master gain
   */
  setMasterGain(gain) {
    this.masterGain = gain;
    if (this.masterGainNode) {
      this.masterGainNode.gain.value = gain;
    }
  }

  /**
   * Set reverb preset
   */
  setReverbPreset(preset, impulseBuffer, wetLevel = 0.3) {
    this.reverbPreset = preset;
    this.reverbMix = wetLevel; // Use preset's wet level

    if (preset === 'none') {
      this.reverbGainNode.gain.value = 0;
    } else if (impulseBuffer) {
      this.reverbNode.buffer = impulseBuffer;
      this.reverbGainNode.gain.value = wetLevel;
    }
  }

  /**
   * Set reverb mode
   */
  setReverbMode(mode) {
    this.reverbMode = mode;

    for (const [id, track] of this.tracks) {
      const nodes = this.trackNodes.get(id);
      if (nodes && nodes.reverbSendL && nodes.reverbSendR) {
        const reverbLevel = this.calculateReverbSend(track.y);
        nodes.reverbSendL.gain.value = reverbLevel;
        nodes.reverbSendR.gain.value = reverbLevel;
      }
    }
  }

  /**
   * Calculate reverb send level
   */
  calculateReverbSend(y) {
    if (this.reverbPreset === 'none') return 0;

    if (this.reverbMode === 'uniform') {
      return this.reverbMix;
    }

    // Depth-based: more reverb for instruments further back
    return this.reverbMix * (0.5 + y * 1.0);
  }

  /**
   * Create audio nodes for a track with dual-mic simulation and directivity
   */
  connectTrack(id, offset = 0) {
    const track = this.tracks.get(id);
    if (!track) return;

    const hasDirectivity = track.frontBuffer && track.bellBuffer;
    const technique = STEREO_TECHNIQUES[this.micConfig.technique];
    const hasCenter = technique?.hasCenter;

    // Clamp offset to buffer duration to prevent WebAudio errors
    const bufferToUse = hasDirectivity ? track.frontBuffer : track.buffer;
    const maxOffset = bufferToUse ? bufferToUse.duration : 0;
    offset = Math.min(Math.max(0, offset), maxOffset);

    // === SOURCE NODES ===
    // Front source (or single source if no directivity)
    const sourceFront = this.context.createBufferSource();
    sourceFront.buffer = hasDirectivity ? track.frontBuffer : track.buffer;

    // Bell source (only if directivity available)
    let sourceBell = null;
    if (hasDirectivity) {
      sourceBell = this.context.createBufferSource();
      sourceBell.buffer = track.bellBuffer;
    }

    // === DIRECTIVITY GAIN NODES ===
    // These control the blend between front and bell mics per channel
    const frontGainL = this.context.createGain();
    const frontGainR = this.context.createGain();
    let frontGainC = null;
    let bellGainL = null;
    let bellGainR = null;
    let bellGainC = null;

    if (hasDirectivity) {
      bellGainL = this.context.createGain();
      bellGainR = this.context.createGain();
    }
    if (hasCenter) {
      frontGainC = this.context.createGain();
      if (hasDirectivity) {
        bellGainC = this.context.createGain();
      }
    }

    // === CHANNEL MIXERS ===
    // Mix front+bell into single L and R signals
    const mixerL = this.context.createGain();
    const mixerR = this.context.createGain();
    let mixerC = null;
    if (hasCenter) {
      mixerC = this.context.createGain();
    }

    // Connect front source to mixers via directivity gains
    sourceFront.connect(frontGainL);
    sourceFront.connect(frontGainR);
    if (hasCenter && frontGainC) {
      sourceFront.connect(frontGainC);
    }
    frontGainL.connect(mixerL);
    frontGainR.connect(mixerR);
    if (hasCenter && frontGainC && mixerC) {
      frontGainC.connect(mixerC);
    }

    // Connect bell source if available
    if (hasDirectivity) {
      sourceBell.connect(bellGainL);
      sourceBell.connect(bellGainR);
      if (hasCenter && bellGainC) {
        sourceBell.connect(bellGainC);
      }
      bellGainL.connect(mixerL);
      bellGainR.connect(mixerR);
      if (hasCenter && bellGainC && mixerC) {
        bellGainC.connect(mixerC);
      }
    }

    // === ITD DELAY AND AIR ABSORPTION ===
    const delayL = this.context.createDelay(0.1); // Max 100ms delay
    const delayR = this.context.createDelay(0.1);

    // Create filter banks for frequency-dependent air absorption (ISO 9613-1)
    const airAbsorbL = this.createAirAbsorptionFilterBank(this.context);
    const airAbsorbR = this.createAirAbsorptionFilterBank(this.context);

    // Connect: mixer -> delay -> filter bank (in series) -> stereo merger
    mixerL.connect(delayL);
    // Chain the L filter bank
    let prevNodeL = delayL;
    for (const filter of airAbsorbL) {
      prevNodeL.connect(filter);
      prevNodeL = filter;
    }
    prevNodeL.connect(this.stereoMerger, 0, 0); // Left channel

    mixerR.connect(delayR);
    // Chain the R filter bank
    let prevNodeR = delayR;
    for (const filter of airAbsorbR) {
      prevNodeR.connect(filter);
      prevNodeR = filter;
    }
    prevNodeR.connect(this.stereoMerger, 0, 1); // Right channel

    // === CENTER MIC CHAIN (Decca Tree) ===
    let delayC = null;
    let airAbsorbC = null;
    let centerBus = null;

    if (hasCenter && mixerC) {
      delayC = this.context.createDelay(0.1);
      airAbsorbC = this.createAirAbsorptionFilterBank(this.context);

      mixerC.connect(delayC);
      let prevNodeC = delayC;
      for (const filter of airAbsorbC) {
        prevNodeC.connect(filter);
        prevNodeC = filter;
      }

      centerBus = this.context.createGain();
      centerBus.gain.value = CENTER_PAN_GAIN;
      prevNodeC.connect(centerBus);
      centerBus.connect(this.stereoMerger, 0, 0);
      centerBus.connect(this.stereoMerger, 0, 1);
    }

    // === GROUND REFLECTION (optional) ===
    let groundBaseGainL, groundDelayL, groundLowFilterL, groundHighFilterL, groundLowGainL, groundHighGainL, groundSumL;
    let groundBaseGainR, groundDelayR, groundLowFilterR, groundHighFilterR, groundLowGainR, groundHighGainR, groundSumR;
    let groundBaseGainC, groundDelayC, groundLowFilterC, groundHighFilterC, groundLowGainC, groundHighGainC, groundSumC;

    if (this.groundReflectionEnabled) {
      const groundModel = this.getGroundReflectionModelConfig();

      groundBaseGainL = this.context.createGain();
      groundDelayL = this.context.createDelay(0.1);
      groundLowFilterL = this.context.createBiquadFilter();
      groundLowFilterL.type = 'lowpass';
      groundLowFilterL.frequency.value = groundModel.crossoverHz;
      groundLowFilterL.Q.value = 0.7;
      groundHighFilterL = this.context.createBiquadFilter();
      groundHighFilterL.type = 'highpass';
      groundHighFilterL.frequency.value = groundModel.crossoverHz;
      groundHighFilterL.Q.value = 0.7;
      groundLowGainL = this.context.createGain();
      groundHighGainL = this.context.createGain();
      groundSumL = this.context.createGain();

      groundBaseGainR = this.context.createGain();
      groundDelayR = this.context.createDelay(0.1);
      groundLowFilterR = this.context.createBiquadFilter();
      groundLowFilterR.type = 'lowpass';
      groundLowFilterR.frequency.value = groundModel.crossoverHz;
      groundLowFilterR.Q.value = 0.7;
      groundHighFilterR = this.context.createBiquadFilter();
      groundHighFilterR.type = 'highpass';
      groundHighFilterR.frequency.value = groundModel.crossoverHz;
      groundHighFilterR.Q.value = 0.7;
      groundLowGainR = this.context.createGain();
      groundHighGainR = this.context.createGain();
      groundSumR = this.context.createGain();

      // Ground reflection uses the mixed signal
      mixerL.connect(groundBaseGainL);
      groundBaseGainL.connect(groundDelayL);
      groundDelayL.connect(groundLowFilterL);
      groundLowFilterL.connect(groundLowGainL);
      groundLowGainL.connect(groundSumL);
      groundDelayL.connect(groundHighFilterL);
      groundHighFilterL.connect(groundHighGainL);
      groundHighGainL.connect(groundSumL);
      groundSumL.connect(this.stereoMerger, 0, 0);

      mixerR.connect(groundBaseGainR);
      groundBaseGainR.connect(groundDelayR);
      groundDelayR.connect(groundLowFilterR);
      groundLowFilterR.connect(groundLowGainR);
      groundLowGainR.connect(groundSumR);
      groundDelayR.connect(groundHighFilterR);
      groundHighFilterR.connect(groundHighGainR);
      groundHighGainR.connect(groundSumR);
      groundSumR.connect(this.stereoMerger, 0, 1);

      if (hasCenter && mixerC && centerBus) {
        groundBaseGainC = this.context.createGain();
        groundDelayC = this.context.createDelay(0.1);
        groundLowFilterC = this.context.createBiquadFilter();
        groundLowFilterC.type = 'lowpass';
        groundLowFilterC.frequency.value = groundModel.crossoverHz;
        groundLowFilterC.Q.value = 0.7;
        groundHighFilterC = this.context.createBiquadFilter();
        groundHighFilterC.type = 'highpass';
        groundHighFilterC.frequency.value = groundModel.crossoverHz;
        groundHighFilterC.Q.value = 0.7;
        groundLowGainC = this.context.createGain();
        groundHighGainC = this.context.createGain();
        groundSumC = this.context.createGain();

        mixerC.connect(groundBaseGainC);
        groundBaseGainC.connect(groundDelayC);
        groundDelayC.connect(groundLowFilterC);
        groundLowFilterC.connect(groundLowGainC);
        groundLowGainC.connect(groundSumC);
        groundDelayC.connect(groundHighFilterC);
        groundHighFilterC.connect(groundHighGainC);
        groundHighGainC.connect(groundSumC);
        groundSumC.connect(centerBus);
      }
    }

    // === REVERB SEND (stereo - preserve L/R separation) ===
    const reverbSendL = this.context.createGain();
    const reverbSendR = this.context.createGain();
    const reverbMerger = this.context.createChannelMerger(2);
    mixerL.connect(reverbSendL);
    mixerR.connect(reverbSendR);
    reverbSendL.connect(reverbMerger, 0, 0);
    reverbSendR.connect(reverbMerger, 0, 1);
    let reverbSendC = null;
    if (hasCenter && mixerC) {
      reverbSendC = this.context.createGain();
      mixerC.connect(reverbSendC);
      reverbSendC.connect(reverbMerger, 0, 0);
      reverbSendC.connect(reverbMerger, 0, 1);
    }
    reverbMerger.connect(this.reverbNode);

    // Store nodes
    const nodes = {
      sourceFront,
      sourceBell,
      frontGainL,
      frontGainR,
      frontGainC,
      bellGainL,
      bellGainR,
      bellGainC,
      mixerL,
      mixerR,
      mixerC,
      delayL,
      delayR,
      delayC,
      airAbsorbL,
      airAbsorbR,
      airAbsorbC,
      centerBus,
      groundBaseGainL,
      groundDelayL,
      groundLowFilterL,
      groundHighFilterL,
      groundLowGainL,
      groundHighGainL,
      groundSumL,
      groundBaseGainR,
      groundDelayR,
      groundLowFilterR,
      groundHighFilterR,
      groundLowGainR,
      groundHighGainR,
      groundSumR,
      groundBaseGainC,
      groundDelayC,
      groundLowFilterC,
      groundHighFilterC,
      groundLowGainC,
      groundHighGainC,
      groundSumC,
      reverbSendL,
      reverbSendR,
      reverbSendC,
      reverbMerger,
      hasDirectivity,
      hasCenter,
      ended: false,
    };

    this.trackNodes.set(id, nodes);

    // Set initial parameters
    this.updateTrackAudioParams(id, track, nodes);

    // Start playback
    sourceFront.start(0, offset);
    if (sourceBell) {
      sourceBell.start(0, offset);
    }

    // Handle playback end
    sourceFront.onended = () => {
      nodes.ended = true;
      if (this.isPlaying) {
        const allEnded = Array.from(this.trackNodes.values()).every(n => {
          return !n.sourceFront.buffer || n.ended;
        });

        if (allEnded && this.onPlaybackEnd) {
          this.onPlaybackEnd();
        }
      }
    };
  }

  /**
   * Disconnect audio nodes for a track
   */
  disconnectTrack(id) {
    const nodes = this.trackNodes.get(id);
    if (!nodes) return;

    // Stop all sources
    try {
      if (nodes.sourceFront) nodes.sourceFront.stop();
    } catch {
      // Ignore if already stopped
    }
    try {
      if (nodes.sourceBell) nodes.sourceBell.stop();
    } catch {
      // Ignore if already stopped
    }

    // Disconnect all nodes
    Object.values(nodes).forEach(node => {
      if (node && typeof node.disconnect === 'function') {
        try {
          node.disconnect();
        } catch {
          // Ignore
        }
      }
    });

    this.trackNodes.delete(id);
  }

  /**
   * Start playback
   */
  async play() {
    if (this.isPlaying) return;

    await this.resume();

    const offset = this.pauseOffset;

    for (const id of this.tracks.keys()) {
      this.connectTrack(id, offset);
    }

    this.startTime = this.context.currentTime - offset;
    this.isPlaying = true;

    this.startTimeUpdateLoop();
  }

  /**
   * Pause playback
   */
  pause() {
    if (!this.isPlaying) return;

    this.pauseOffset = this.getCurrentTime();
    this.stop(false);
  }

  /**
   * Stop playback
   */
  stop(resetPosition = true) {
    for (const id of this.trackNodes.keys()) {
      this.disconnectTrack(id);
    }

    this.isPlaying = false;

    if (resetPosition) {
      this.pauseOffset = 0;
    }

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  /**
   * Seek to a position
   */
  seek(time) {
    time = Math.max(0, Math.min(time, this.duration));

    if (this.isPlaying) {
      this.stop(false);
      this.pauseOffset = time;
      this.play();
    } else {
      this.pauseOffset = time;
    }
  }

  /**
   * Get current playback time
   */
  getCurrentTime() {
    if (!this.isPlaying) {
      return this.pauseOffset;
    }

    const elapsed = this.context.currentTime - this.startTime;
    return Math.min(elapsed, this.duration);
  }

  /**
   * Start the time update loop
   */
  startTimeUpdateLoop() {
    const update = () => {
      if (!this.isPlaying) return;

      const currentTime = this.getCurrentTime();

      if (this.onTimeUpdate) {
        this.onTimeUpdate(currentTime, this.duration);
      }

      if (currentTime >= this.duration) {
        this.stop();
        if (this.onPlaybackEnd) {
          this.onPlaybackEnd();
        }
        return;
      }

      this.animationFrame = requestAnimationFrame(update);
    };

    this.animationFrame = requestAnimationFrame(update);
  }

  /**
   * Render the mix offline for export
   */
  async renderOffline(onProgress, signal) {
    // Use context's sample rate to match playback and avoid resampling
    const sampleRate = this.context ? this.context.sampleRate : 44100;
    const length = Math.ceil(this.duration * sampleRate);
    const offlineContext = new OfflineAudioContext(2, length, sampleRate);

    // Create master limiter (matches realtime chain)
    const masterLimiter = offlineContext.createDynamicsCompressor();
    masterLimiter.threshold.value = -1;
    masterLimiter.knee.value = 0;
    masterLimiter.ratio.value = 20;
    masterLimiter.attack.value = 0.001;
    masterLimiter.release.value = 0.05;
    masterLimiter.connect(offlineContext.destination);

    // Create master gain
    const masterGain = offlineContext.createGain();
    masterGain.gain.value = this.masterGain;
    masterGain.connect(masterLimiter);

    // Create stereo merger
    const stereoMerger = offlineContext.createChannelMerger(2);
    stereoMerger.connect(masterGain);

    // Create reverb
    let reverbConvolver = null;
    const reverbGain = offlineContext.createGain();
    reverbGain.gain.value = this.reverbPreset === 'none' ? 0 : this.reverbMix;
    reverbGain.connect(masterGain);

    if (this.reverbNode.buffer && this.reverbPreset !== 'none') {
      reverbConvolver = offlineContext.createConvolver();
      reverbConvolver.buffer = this.reverbNode.buffer;
      reverbConvolver.connect(reverbGain);
    }

    const hasSolo = Array.from(this.tracks.values()).some(t => t.solo);
    const technique = STEREO_TECHNIQUES[this.micConfig.technique];
    const hasCenter = technique?.hasCenter;
    const groundModel = this.groundReflectionEnabled ? this.getGroundReflectionModelConfig() : null;

    for (const [, track] of this.tracks) {
      if (signal && signal.aborted) {
        throw new DOMException('Render cancelled', 'AbortError');
      }

      if (track.muted) continue;
      if (hasSolo && !track.solo) continue;

      // Use normalized position for stereo response calculation
      const sourcePosNormalized = { x: track.x, y: track.y };
      const sourcePos = this.normalizedToMeters(track.x, track.y);

      // Calculate stereo response using microphone simulation (matches realtime)
      const stereoResponse = calculateStereoResponse(sourcePosNormalized, this.micConfig, STAGE_CONFIG);

      const micResponses = stereoResponse.micResponses || {};
      const responseL = micResponses.L;
      const responseR = micResponses.R;
      const responseC = hasCenter ? micResponses.C : null;

      // Use stereo response gains (includes polar pattern and distance attenuation)
      // Use signed gains to preserve rear-lobe phase inversion
      const ampL = hasCenter && responseL ? responseL.gain : stereoResponse.left.gain;
      const ampR = hasCenter && responseR ? responseR.gain : stereoResponse.right.gain;
      const ampC = responseC ? responseC.gain : 0;

      // Use stereo response delays
      const timeL = responseL?.delay ?? stereoResponse.left.delay;
      const timeR = responseR?.delay ?? stereoResponse.right.delay;
      const timeC = responseC?.delay ?? null;

      // Get distances from stereo response for air absorption
      const distL = responseL?.distance || 3;
      const distR = responseR?.distance || 3;
      const distC = responseC?.distance || 3;

      // Keep refDist for ground reflection calculations
      const refDist = 3;

      // Base delay: preserves depth timing cues (relative to front of stage)
      const refDistance = Math.abs(this.micConfig.micY);
      const refTime = refDistance / SPEED_OF_SOUND;
      const avgTime = (timeL + timeR) / 2;
      const baseDelay = Math.max(0, avgTime - refTime);

      // ITD: L/R difference
      const minTime = (hasCenter && timeC !== null) ? Math.min(timeL, timeR, timeC) : Math.min(timeL, timeR);
      const itdL = timeL - minTime;
      const itdR = timeR - minTime;
      const itdC = (hasCenter && timeC !== null) ? timeC - minTime : 0;

      // Check for directivity blending
      const hasDirectivity = track.frontBuffer && track.bellBuffer;
      const blendL = this.calculateDirectivityBlend(sourcePos, this.micL);
      const blendR = this.calculateDirectivityBlend(sourcePos, this.micR);
      const blendC = (hasCenter && this.micC)
        ? this.calculateDirectivityBlend(sourcePos, this.micC)
        : { front: 1, bell: 0 };

      // Create mixer nodes for blending front/bell sources
      const mixerL = offlineContext.createGain();
      const mixerR = offlineContext.createGain();
      const mixerC = hasCenter ? offlineContext.createGain() : null;

      if (hasDirectivity) {
        // Front source
        const sourceFront = offlineContext.createBufferSource();
        sourceFront.buffer = track.frontBuffer;
        const frontGainL = offlineContext.createGain();
        const frontGainR = offlineContext.createGain();
        const frontGainC = hasCenter ? offlineContext.createGain() : null;
        frontGainL.gain.value = ampL * track.gain * blendL.front;
        frontGainR.gain.value = ampR * track.gain * blendR.front;
        if (frontGainC) {
          frontGainC.gain.value = ampC * track.gain * blendC.front;
        }
        sourceFront.connect(frontGainL);
        sourceFront.connect(frontGainR);
        if (frontGainC) {
          sourceFront.connect(frontGainC);
        }
        frontGainL.connect(mixerL);
        frontGainR.connect(mixerR);
        if (frontGainC && mixerC) {
          frontGainC.connect(mixerC);
        }
        sourceFront.start(0);

        // Bell source
        const sourceBell = offlineContext.createBufferSource();
        sourceBell.buffer = track.bellBuffer;
        const bellGainL = offlineContext.createGain();
        const bellGainR = offlineContext.createGain();
        const bellGainC = hasCenter ? offlineContext.createGain() : null;
        bellGainL.gain.value = ampL * track.gain * blendL.bell;
        bellGainR.gain.value = ampR * track.gain * blendR.bell;
        if (bellGainC) {
          bellGainC.gain.value = ampC * track.gain * blendC.bell;
        }
        sourceBell.connect(bellGainL);
        sourceBell.connect(bellGainR);
        if (bellGainC) {
          sourceBell.connect(bellGainC);
        }
        bellGainL.connect(mixerL);
        bellGainR.connect(mixerR);
        if (bellGainC && mixerC) {
          bellGainC.connect(mixerC);
        }
        sourceBell.start(0);
      } else {
        // Single source (no directivity)
        const source = offlineContext.createBufferSource();
        source.buffer = track.buffer;
        const gainL = offlineContext.createGain();
        const gainR = offlineContext.createGain();
        const gainC = hasCenter ? offlineContext.createGain() : null;
        gainL.gain.value = ampL * track.gain;
        gainR.gain.value = ampR * track.gain;
        if (gainC) {
          gainC.gain.value = ampC * track.gain;
        }
        source.connect(gainL);
        source.connect(gainR);
        if (gainC) {
          source.connect(gainC);
        }
        gainL.connect(mixerL);
        gainR.connect(mixerR);
        if (gainC && mixerC) {
          gainC.connect(mixerC);
        }
        source.start(0);
      }

      // Left channel processing with frequency-dependent air absorption
      const delayL = offlineContext.createDelay(0.1);
      delayL.delayTime.value = baseDelay + itdL;
      const absorbL = this.createAirAbsorptionFilterBank(offlineContext);
      const absorptionL = this.calculateAirAbsorption(distL);
      absorbL.forEach((filter, i) => { filter.gain.value = absorptionL[i].gainDb; });
      mixerL.connect(delayL);
      let prevL = delayL;
      for (const filter of absorbL) {
        prevL.connect(filter);
        prevL = filter;
      }
      prevL.connect(stereoMerger, 0, 0);

      // Right channel processing with frequency-dependent air absorption
      const delayR = offlineContext.createDelay(0.1);
      delayR.delayTime.value = baseDelay + itdR;
      const absorbR = this.createAirAbsorptionFilterBank(offlineContext);
      const absorptionR = this.calculateAirAbsorption(distR);
      absorbR.forEach((filter, i) => { filter.gain.value = absorptionR[i].gainDb; });
      mixerR.connect(delayR);
      let prevR = delayR;
      for (const filter of absorbR) {
        prevR.connect(filter);
        prevR = filter;
      }
      prevR.connect(stereoMerger, 0, 1);

      // Center channel processing (Decca Tree)
      let centerBus = null;
      if (hasCenter && mixerC) {
        const delayC = offlineContext.createDelay(0.1);
        delayC.delayTime.value = baseDelay + itdC;
        const absorbC = this.createAirAbsorptionFilterBank(offlineContext);
        const absorptionC = this.calculateAirAbsorption(distC);
        absorbC.forEach((filter, i) => { filter.gain.value = absorptionC[i].gainDb; });
        mixerC.connect(delayC);
        let prevC = delayC;
        for (const filter of absorbC) {
          prevC.connect(filter);
          prevC = filter;
        }
        centerBus = offlineContext.createGain();
        centerBus.gain.value = CENTER_PAN_GAIN;
        prevC.connect(centerBus);
        centerBus.connect(stereoMerger, 0, 0);
        centerBus.connect(stereoMerger, 0, 1);
      }

      // Ground reflection
      if (this.groundReflectionEnabled && groundModel) {
        const groundDistL = this.calculateGroundReflectionDistance(
          sourcePos, this.micL, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );
        const groundDistR = this.calculateGroundReflectionDistance(
          sourcePos, this.micR, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );

        // Ground reflection timing must match direct sound timing structure (baseDelay + ITD + groundExtra)
        const groundTimeL = groundDistL / SPEED_OF_SOUND;
        const groundTimeR = groundDistR / SPEED_OF_SOUND;
        const groundExtraL = Math.max(0, groundTimeL - timeL);
        const groundExtraR = Math.max(0, groundTimeR - timeR);

        const lowGain = groundModel.lowGain * STAGE_CONFIG.groundReflectionCoeff;
        const highGain = groundModel.highGain * STAGE_CONFIG.groundReflectionCoeff;
        const crossFreq = groundModel.crossoverHz;

        const baseAmpL = Math.min(1.0, refDist / groundDistL) * track.gain;
        const groundBaseGainL = offlineContext.createGain();
        groundBaseGainL.gain.value = baseAmpL;
        const groundDelayL = offlineContext.createDelay(0.1);
        groundDelayL.delayTime.value = baseDelay + itdL + groundExtraL;
        const groundLowFilterL = offlineContext.createBiquadFilter();
        groundLowFilterL.type = 'lowpass';
        groundLowFilterL.frequency.value = crossFreq;
        groundLowFilterL.Q.value = 0.7;
        const groundHighFilterL = offlineContext.createBiquadFilter();
        groundHighFilterL.type = 'highpass';
        groundHighFilterL.frequency.value = crossFreq;
        groundHighFilterL.Q.value = 0.7;
        const groundLowGainL = offlineContext.createGain();
        groundLowGainL.gain.value = lowGain;
        const groundHighGainL = offlineContext.createGain();
        groundHighGainL.gain.value = highGain;
        const groundSumL = offlineContext.createGain();
        mixerL.connect(groundBaseGainL);
        groundBaseGainL.connect(groundDelayL);
        groundDelayL.connect(groundLowFilterL);
        groundLowFilterL.connect(groundLowGainL);
        groundLowGainL.connect(groundSumL);
        groundDelayL.connect(groundHighFilterL);
        groundHighFilterL.connect(groundHighGainL);
        groundHighGainL.connect(groundSumL);
        groundSumL.connect(stereoMerger, 0, 0);

        const baseAmpR = Math.min(1.0, refDist / groundDistR) * track.gain;
        const groundBaseGainR = offlineContext.createGain();
        groundBaseGainR.gain.value = baseAmpR;
        const groundDelayR = offlineContext.createDelay(0.1);
        groundDelayR.delayTime.value = baseDelay + itdR + groundExtraR;
        const groundLowFilterR = offlineContext.createBiquadFilter();
        groundLowFilterR.type = 'lowpass';
        groundLowFilterR.frequency.value = crossFreq;
        groundLowFilterR.Q.value = 0.7;
        const groundHighFilterR = offlineContext.createBiquadFilter();
        groundHighFilterR.type = 'highpass';
        groundHighFilterR.frequency.value = crossFreq;
        groundHighFilterR.Q.value = 0.7;
        const groundLowGainR = offlineContext.createGain();
        groundLowGainR.gain.value = lowGain;
        const groundHighGainR = offlineContext.createGain();
        groundHighGainR.gain.value = highGain;
        const groundSumR = offlineContext.createGain();
        mixerR.connect(groundBaseGainR);
        groundBaseGainR.connect(groundDelayR);
        groundDelayR.connect(groundLowFilterR);
        groundLowFilterR.connect(groundLowGainR);
        groundLowGainR.connect(groundSumR);
        groundDelayR.connect(groundHighFilterR);
        groundHighFilterR.connect(groundHighGainR);
        groundHighGainR.connect(groundSumR);
        groundSumR.connect(stereoMerger, 0, 1);

        if (hasCenter && mixerC && centerBus && this.micC && timeC !== null) {
          const groundDistC = this.calculateGroundReflectionDistance(
            sourcePos, this.micC, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
          );
          const groundTimeC = groundDistC / SPEED_OF_SOUND;
          const groundExtraC = Math.max(0, groundTimeC - timeC);

          const baseAmpC = Math.min(1.0, refDist / groundDistC) * track.gain;
          const groundBaseGainC = offlineContext.createGain();
          groundBaseGainC.gain.value = baseAmpC;
          const groundDelayC = offlineContext.createDelay(0.1);
          groundDelayC.delayTime.value = baseDelay + itdC + groundExtraC;
          const groundLowFilterC = offlineContext.createBiquadFilter();
          groundLowFilterC.type = 'lowpass';
          groundLowFilterC.frequency.value = crossFreq;
          groundLowFilterC.Q.value = 0.7;
          const groundHighFilterC = offlineContext.createBiquadFilter();
          groundHighFilterC.type = 'highpass';
          groundHighFilterC.frequency.value = crossFreq;
          groundHighFilterC.Q.value = 0.7;
          const groundLowGainC = offlineContext.createGain();
          groundLowGainC.gain.value = lowGain;
          const groundHighGainC = offlineContext.createGain();
          groundHighGainC.gain.value = highGain;
          const groundSumC = offlineContext.createGain();

          mixerC.connect(groundBaseGainC);
          groundBaseGainC.connect(groundDelayC);
          groundDelayC.connect(groundLowFilterC);
          groundLowFilterC.connect(groundLowGainC);
          groundLowGainC.connect(groundSumC);
          groundDelayC.connect(groundHighFilterC);
          groundHighFilterC.connect(groundHighGainC);
          groundHighGainC.connect(groundSumC);
          groundSumC.connect(centerBus);
        }
      }

      // Reverb send (stereo - send L and R separately through stereo merger)
      if (reverbConvolver) {
        const reverbSendL = offlineContext.createGain();
        const reverbSendR = offlineContext.createGain();
        const reverbLevel = this.calculateReverbSend(track.y);
        reverbSendL.gain.value = reverbLevel;
        reverbSendR.gain.value = reverbLevel;
        const reverbSendC = hasCenter && mixerC ? offlineContext.createGain() : null;
        if (reverbSendC) {
          reverbSendC.gain.value = reverbLevel * CENTER_PAN_GAIN;
        }
        mixerL.connect(reverbSendL);
        mixerR.connect(reverbSendR);
        if (reverbSendC) {
          mixerC.connect(reverbSendC);
        }
        // Create stereo merger for reverb input
        const reverbMerger = offlineContext.createChannelMerger(2);
        reverbSendL.connect(reverbMerger, 0, 0);
        reverbSendR.connect(reverbMerger, 0, 1);
        if (reverbSendC) {
          reverbSendC.connect(reverbMerger, 0, 0);
          reverbSendC.connect(reverbMerger, 0, 1);
        }
        reverbMerger.connect(reverbConvolver);
      }
    }

    const startRenderTime = performance.now();
    const estimatedRenderTime = this.duration * 100;

    const progressInterval = setInterval(() => {
      if (signal && signal.aborted) {
        clearInterval(progressInterval);
        return;
      }

      const elapsed = performance.now() - startRenderTime;
      const progress = Math.min(elapsed / estimatedRenderTime, 0.95);

      if (onProgress) {
        onProgress(progress);
      }
    }, 100);

    try {
      const renderedBuffer = await offlineContext.startRendering();
      clearInterval(progressInterval);

      if (onProgress) {
        onProgress(1);
      }

      return renderedBuffer;
    } catch (error) {
      clearInterval(progressInterval);
      throw error;
    }
  }

  /**
   * Get track data
   */
  getTrack(id) {
    return this.tracks.get(id);
  }

  /**
   * Get all tracks
   */
  getAllTracks() {
    return this.tracks;
  }
}

// Re-export microphone types and helpers for use by other modules
export {
  STEREO_TECHNIQUES,
  POLAR_PATTERNS,
  RECORDING_PRESETS,
  createMicrophoneConfig,
  createConfigFromPreset,
  applyTechniqueLayout,
  validateConfig,
} from './microphone-types.js';

export {
  calculateStereoResponse,
  calculatePolarGain,
  getPolarPatternPoints,
  calculateITD,
  calculateILD,
} from './microphone-math.js';

// Export stage config for use by other modules
export { STAGE_CONFIG, GROUND_REFLECTION_MODELS };
