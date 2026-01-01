// Web Audio API engine with physically accurate stereo simulation
// Features: ITD, 1/d amplitude, frequency-dependent air absorption, optional ground reflection
// Microphone modeling: polar patterns, stereo techniques (AB, XY, ORTF, Blumlein, Decca Tree)

import {
  createMicrophoneConfig,
  createConfigFromPreset,
  cloneMicConfig,
  applyTechniqueLayout,
  validateConfig,
  STEREO_TECHNIQUES,
  POLAR_PATTERNS,
  RECORDING_PRESETS,
} from './microphone-types.js';

import {
  calculateStereoResponse,
  calculatePolarGain,
  calculateGroundReflectionPolarGain,
  getPolarPatternPoints,
} from './microphone-math.js';

// Physical constants
const SPEED_OF_SOUND = 343; // m/s at 20°C
const PATTERN_GAIN_EPS = 1e-4;
const VISUAL_NOISE_MARGIN_DB = 12;
const VISUAL_DYNAMIC_RANGE_DB = 40;
const DEFAULT_NOISE_FLOOR_DB = -90;
const ANALYSER_FFT_SIZE = 2048;
const MASTER_ANALYSER_FFT_SIZE = 4096;
const MASTER_METER_WARMUP_SECONDS = 0.05;
const GRAPH_CROSSFADE_SECONDS = 0.12;
const GRAPH_REBUILD_DEBOUNCE_MS = 140;
const DEFAULT_GRAPH_SWAP_MODE = 'nonOverlap';
const TOGGLE_CROSSFADE_SECONDS = 0.08;
const PARAM_RAMP_SECONDS = 0.03;

function safePatternGain(gain) {
  if (!Number.isFinite(gain)) return PATTERN_GAIN_EPS;
  if (Math.abs(gain) < PATTERN_GAIN_EPS) {
    return gain < 0 ? -PATTERN_GAIN_EPS : PATTERN_GAIN_EPS;
  }
  return gain;
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function linearToDb(linear, minDb = DEFAULT_NOISE_FLOOR_DB) {
  if (!Number.isFinite(linear) || linear <= 0) return minDb;
  return Math.max(minDb, 20 * Math.log10(linear));
}

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
    this.masterAnalyser = null;
    this.masterAnalyserFloatData = null;
    this.masterAnalyserByteData = null;
    this.activeBus = null;
    this.pendingBus = null;
    this.pendingTrackNodes = null;
    this.reverbImpulseBuffer = null;

    this.trackNodes = new Map(); // trackId -> { sourceL, sourceR, ... }
    this.tracks = new Map(); // trackId -> track data
    this.soloCount = 0;
    this.hasSolo = false;

    this.isPlaying = false;
    this.startTime = 0;
    this.pauseOffset = 0;
    this.duration = 0;

    this.masterGain = 1.0;
    this.reverbPreset = 'none';
    this.reverbMode = 'depth'; // 'depth' or 'uniform'
    this.reverbPresetWet = 0;
    this.reverbWet = 1;
    this.reverbMix = 0;
    this.groundReflectionEnabled = false;
    this.groundReflectionModel = DEFAULT_GROUND_REFLECTION_MODEL;

    this.onTimeUpdate = null;
    this.onPlaybackEnd = null;
    this.animationFrame = null;
    this.graphRebuildTimer = null;
    this.graphRebuildPending = null;
    this.graphRebuildQueued = null;
    this.graphRebuildInProgress = false;
    this.crossfadeTimer = null;
    this.busDisposeTimers = new Set();

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
   * Also stores mic pattern and angle for ground reflection calculations
   */
  _updateLegacyMicPositions() {
    const layoutConfig = applyTechniqueLayout(cloneMicConfig(this.micConfig));
    const baseY = this.micConfig.micY;

    // Find L, R, and C mics
    const micL = layoutConfig.mics.find(m => m.id === 'L');
    const micR = layoutConfig.mics.find(m => m.id === 'R');
    const micC = layoutConfig.mics.find(m => m.id === 'C');

    if (micL) {
      this.micL = { x: micL.offsetX, y: baseY + (micL.offsetY || 0) };
      this.micLPattern = micL.pattern || 'omni';
      this.micLAngle = micL.angle || 0;
    }
    if (micR) {
      this.micR = { x: micR.offsetX, y: baseY + (micR.offsetY || 0) };
      this.micRPattern = micR.pattern || 'omni';
      this.micRAngle = micR.angle || 0;
    }
    if (micC) {
      this.micC = { x: micC.offsetX, y: baseY + (micC.offsetY || 0) };
      this.micCPattern = micC.pattern || 'omni';
      this.micCAngle = micC.angle || 0;
    } else {
      this.micC = null;
      this.micCPattern = null;
      this.micCAngle = null;
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

    // Master analyser for output metering (tap post-master, pre-limiter)
    this.masterAnalyser = this.context.createAnalyser();
    this.masterAnalyser.fftSize = MASTER_ANALYSER_FFT_SIZE;
    this.masterAnalyser.smoothingTimeConstant = 0.3;
    this.masterGainNode.connect(this.masterAnalyser);
    this.masterAnalyserFloatData = typeof this.masterAnalyser.getFloatTimeDomainData === 'function'
      ? new Float32Array(this.masterAnalyser.fftSize)
      : null;
    this.masterAnalyserByteData = this.masterAnalyserFloatData ? null : new Uint8Array(this.masterAnalyser.fftSize);

    // Create initial mix bus (A/B graph crossfade support)
    this.activeBus = this._createBus({ initialGain: 1 });
  }

  /**
   * Create a mix bus with its own stereo merger + reverb chain.
   */
  _createBus({ initialGain = 0 } = {}) {
    const stereoMerger = this.context.createChannelMerger(2);
    const outputGain = this.context.createGain();
    outputGain.gain.value = initialGain;
    stereoMerger.connect(outputGain);

    const reverbGainNode = this.context.createGain();
    reverbGainNode.gain.value = this.reverbPreset === 'none' ? 0 : 1;
    reverbGainNode.connect(outputGain);

    const reverbNode = this.context.createConvolver();
    if (this.reverbImpulseBuffer) {
      reverbNode.buffer = this.reverbImpulseBuffer;
    }
    reverbNode.connect(reverbGainNode);

    outputGain.connect(this.masterGainNode);

    return {
      stereoMerger,
      reverbNode,
      reverbGainNode,
      outputGain,
    };
  }

  _applyReverbToBus(bus) {
    if (!bus) return;
    if (this.reverbPreset === 'none' || !this.reverbImpulseBuffer) {
      bus.reverbGainNode.gain.value = 0;
      bus.reverbNode.buffer = null;
    } else {
      bus.reverbNode.buffer = this.reverbImpulseBuffer;
      bus.reverbGainNode.gain.value = 1;
    }
  }

  _disconnectBus(bus) {
    if (!bus) return;
    for (const node of [bus.stereoMerger, bus.reverbNode, bus.reverbGainNode, bus.outputGain]) {
      if (node && typeof node.disconnect === 'function') {
        try {
          node.disconnect();
        } catch {
          // Ignore
        }
      }
    }
    bus.disposed = true;
  }

  _disconnectTrackNodes(nodes) {
    if (!nodes) return;

    nodes.isSuperseded = true;

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
  }

  _disconnectTrackMap(nodeMap) {
    if (!nodeMap) return;
    for (const nodes of nodeMap.values()) {
      this._disconnectTrackNodes(nodes);
    }
    nodeMap.clear();
  }

  _holdBusGain(bus) {
    if (!bus || !bus.outputGain || !this.context) return;
    const now = this.context.currentTime;
    const gainParam = bus.outputGain.gain;
    if (typeof gainParam.cancelAndHoldAtTime === 'function') {
      gainParam.cancelAndHoldAtTime(now);
    } else {
      gainParam.cancelScheduledValues(now);
      gainParam.setValueAtTime(gainParam.value, now);
    }
  }

  _disposeBusWithFade(bus, nodeMap, fadeSeconds = 0.03) {
    if (!bus || !this.context || bus.disposed) {
      this._disconnectTrackMap(nodeMap);
      return;
    }

    const now = this.context.currentTime;
    const gainParam = bus.outputGain?.gain;
    if (gainParam) {
      if (typeof gainParam.cancelAndHoldAtTime === 'function') {
        gainParam.cancelAndHoldAtTime(now);
      } else {
        gainParam.cancelScheduledValues(now);
        gainParam.setValueAtTime(gainParam.value, now);
      }
      gainParam.linearRampToValueAtTime(0, now + fadeSeconds);
    }

    const timerId = setTimeout(() => {
      this.busDisposeTimers.delete(timerId);
      if (bus.disposed) return;
      this._disconnectTrackMap(nodeMap);
      this._disconnectBus(bus);
    }, (fadeSeconds + 0.05) * 1000);
    this.busDisposeTimers.add(timerId);
  }

  _cancelGraphRebuild() {
    if (this.graphRebuildTimer) {
      clearTimeout(this.graphRebuildTimer);
      this.graphRebuildTimer = null;
    }
  }

  _cancelCrossfade() {
    if (this.crossfadeTimer) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
  }

  scheduleGraphRebuild({
    delayMs = GRAPH_REBUILD_DEBOUNCE_MS,
    mode = DEFAULT_GRAPH_SWAP_MODE,
    duration = GRAPH_CROSSFADE_SECONDS,
  } = {}) {
    if (!this.isPlaying) {
      this._updateAllTracks();
      return;
    }

    this.graphRebuildPending = { mode, duration };
    this._cancelGraphRebuild();
    this.graphRebuildTimer = setTimeout(() => {
      this.graphRebuildTimer = null;
      this._flushGraphRebuild();
    }, delayMs);
  }

  _flushGraphRebuild() {
    const config = this.graphRebuildPending;
    this.graphRebuildPending = null;
    if (!config) return;

    if (this.graphRebuildInProgress) {
      this.graphRebuildQueued = config;
      return;
    }

    this.rebuildGraphWithCrossfade(config);
  }

  rebuildGraphWithCrossfade({ duration = GRAPH_CROSSFADE_SECONDS, mode = DEFAULT_GRAPH_SWAP_MODE } = {}) {
    if (!this.isPlaying) {
      this._updateAllTracks();
      return;
    }

    if (this.graphRebuildInProgress) {
      this.graphRebuildQueued = { mode, duration };
      return;
    }

    if (!this.context) return;

    // Cancel any pending rebuilds/crossfades
    this._cancelGraphRebuild();
    this._cancelCrossfade();

    if (this.pendingBus) {
      this._disposeBusWithFade(this.pendingBus, this.pendingTrackNodes);
      this.pendingBus = null;
      this.pendingTrackNodes = null;
    }

    this._holdBusGain(this.activeBus);

    this.graphRebuildInProgress = true;
    const offset = this.getCurrentTime();
    const nextBus = this._createBus({ initialGain: 0 });
    const nextTrackNodes = new Map();

    for (const id of this.tracks.keys()) {
      this.connectTrack(id, offset, nextBus, nextTrackNodes);
    }

    this._startGraphCrossfade(nextBus, nextTrackNodes, duration, mode);
  }

  _startGraphCrossfade(nextBus, nextTrackNodes, duration, mode) {
    if (!nextBus) return;

    const currentBus = this.activeBus;
    const now = this.context.currentTime;

    if (!currentBus) {
      this.activeBus = nextBus;
      this.trackNodes = nextTrackNodes;
      nextBus.outputGain.gain.setValueAtTime(1, now);
      return;
    }

    this.pendingBus = nextBus;
    this.pendingTrackNodes = nextTrackNodes;

    this._holdBusGain(currentBus);
    nextBus.outputGain.gain.cancelScheduledValues(now);
    nextBus.outputGain.gain.setValueAtTime(0, now);

    if (mode === 'nonOverlap') {
      currentBus.outputGain.gain.linearRampToValueAtTime(0, now + duration);
      nextBus.outputGain.gain.setValueAtTime(0, now + duration);
      nextBus.outputGain.gain.linearRampToValueAtTime(1, now + duration * 2);
      this.crossfadeTimer = setTimeout(() => {
        this._finishGraphCrossfade();
      }, (duration * 2 + 0.05) * 1000);
      return;
    }

    currentBus.outputGain.gain.linearRampToValueAtTime(0, now + duration);
    nextBus.outputGain.gain.linearRampToValueAtTime(1, now + duration);

    this.crossfadeTimer = setTimeout(() => {
      this._finishGraphCrossfade();
    }, (duration + 0.05) * 1000);
  }

  _finishGraphCrossfade() {
    this.crossfadeTimer = null;
    if (!this.pendingBus) {
      this.graphRebuildInProgress = false;
      if (this.graphRebuildQueued) {
        const queued = this.graphRebuildQueued;
        this.graphRebuildQueued = null;
        this.rebuildGraphWithCrossfade(queued);
      }
      return;
    }

    const oldBus = this.activeBus;
    const oldTrackNodes = this.trackNodes;

    this.activeBus = this.pendingBus;
    this.trackNodes = this.pendingTrackNodes || new Map();
    this.pendingBus = null;
    this.pendingTrackNodes = null;

    if (this.activeBus) {
      this.activeBus.outputGain.gain.value = 1;
    }

    this._disconnectTrackMap(oldTrackNodes);
    this._disconnectBus(oldBus);

    this.graphRebuildInProgress = false;
    if (this.graphRebuildQueued) {
      const queued = this.graphRebuildQueued;
      this.graphRebuildQueued = null;
      this.rebuildGraphWithCrossfade(queued);
    }
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
      noiseFloorDb: Number.isFinite(options.noiseFloorDb) ? options.noiseFloorDb : DEFAULT_NOISE_FLOOR_DB,
      noiseFloorByMic: options.noiseFloorByMic ?? null,
      primaryMicPosition: options.primaryMicPosition ?? '6',
    };

    // Extract front (mic 6) and bell (mic 8) buffers for directivity
    if (track.directivityBuffers && track.directivityBuffers.size > 1) {
      track.frontBuffer = track.directivityBuffers.get('6') || buffer;
      track.bellBuffer = track.directivityBuffers.get('8') || null;
    }

    this.tracks.set(id, track);
    if (track.solo) {
      this.soloCount += 1;
      this.hasSolo = this.soloCount > 0;
    }

    if (buffer.duration > this.duration) {
      this.duration = buffer.duration;
    }
  }

  /**
   * Remove a track
   */
  removeTrack(id) {
    const track = this.tracks.get(id);
    if (track?.solo) {
      this.soloCount = Math.max(0, this.soloCount - 1);
      this.hasSolo = this.soloCount > 0;
    }
    this.disconnectTrack(id, this.trackNodes);
    this.disconnectTrack(id, this.pendingTrackNodes);
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
    this.soloCount = 0;
    this.hasSolo = false;
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

    if (this.isPlaying) {
      this.scheduleGraphRebuild({
        delayMs: GRAPH_REBUILD_DEBOUNCE_MS,
        mode: 'overlap',
        duration: TOGGLE_CROSSFADE_SECONDS,
      });
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
    if (this.isPlaying) {
      this.scheduleGraphRebuild({
        delayMs: GRAPH_REBUILD_DEBOUNCE_MS,
        mode: 'overlap',
        duration: TOGGLE_CROSSFADE_SECONDS,
      });
    } else {
      this._updateAllTracks();
    }
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
    if (this.isPlaying) {
      this.scheduleGraphRebuild();
    } else {
      this._updateAllTracks();
    }
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
    if (this.isPlaying) {
      this.scheduleGraphRebuild();
    } else {
      this._updateAllTracks();
    }
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

    if (this.isPlaying) {
      this.scheduleGraphRebuild();
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
    if (this.isPlaying) {
      this.scheduleGraphRebuild();
    } else {
      this._updateAllTracks();
    }
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

    this._updateLegacyMicPositions();
    if (this.isPlaying) {
      this.scheduleGraphRebuild();
    } else {
      this._updateAllTracks();
    }
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
    if (this.isPlaying) {
      this.scheduleGraphRebuild();
    } else {
      this._updateAllTracks();
    }
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
    if (this.isPlaying) {
      this.scheduleGraphRebuild();
    } else {
      this._updateAllTracks();
    }
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
    if (this.isPlaying) {
      this.scheduleGraphRebuild();
    } else {
      this._updateAllTracks();
    }
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
    if (this.isPlaying) {
      this.scheduleGraphRebuild();
    } else {
      this._updateAllTracks();
    }
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

    if (this.isPlaying) {
      this.scheduleGraphRebuild();
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

    if (this.isPlaying) {
      this.scheduleGraphRebuild();
    } else {
      this._updateAllTracks();
    }
  }

  /**
   * Update all track audio params
   */
  _updateAllTracks() {
    const nodeMaps = [this.trackNodes, this.pendingTrackNodes].filter(Boolean);
    for (const nodeMap of nodeMaps) {
      for (const [id, nodes] of nodeMap.entries()) {
        const track = this.tracks.get(id);
        if (track) {
          this.updateTrackAudioParams(id, track, nodes);
        }
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

    if (this.isPlaying) {
      this.scheduleGraphRebuild();
      return;
    }

    const nodeMaps = [this.trackNodes, this.pendingTrackNodes].filter(Boolean);
    for (const nodeMap of nodeMaps) {
      const nodes = nodeMap.get(id);
      if (nodes) {
        this.updateTrackAudioParams(id, track, nodes);
      }
    }
  }

  getNoiseFloorForMic(track, micPos) {
    const fallback = Number.isFinite(track.noiseFloorDb) ? track.noiseFloorDb : DEFAULT_NOISE_FLOOR_DB;
    const map = track.noiseFloorByMic;
    if (!map) return fallback;
    if (map instanceof Map) {
      const value = map.get(micPos);
      return Number.isFinite(value) ? value : fallback;
    }
    if (typeof map === 'object') {
      const value = map[micPos];
      return Number.isFinite(value) ? value : fallback;
    }
    return fallback;
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
    const directPatternL = responseL?.patternGain ?? 1;
    const directPatternR = responseR?.patternGain ?? 1;
    const directPatternC = responseC?.patternGain ?? 1;

    // Track distances for air absorption (from mic responses)
    const effectiveDistL = responseL?.distance || 3;
    const effectiveDistR = responseR?.distance || 3;
    const effectiveDistC = responseC?.distance || 3;

    // Apply track gain and mute/solo
    const hasSolo = this.hasSolo;
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
      const frontGainLValue = ampL * gainMultiplier * blendL.front;
      const frontGainRValue = ampR * gainMultiplier * blendR.front;
      const bellGainLValue = ampL * gainMultiplier * blendL.bell;
      const bellGainRValue = ampR * gainMultiplier * blendR.bell;

      nodes.frontGainL.gain.setTargetAtTime(frontGainLValue, now, rampTime);
      nodes.frontGainR.gain.setTargetAtTime(frontGainRValue, now, rampTime);
      nodes.bellGainL.gain.setTargetAtTime(bellGainLValue, now, rampTime);
      nodes.bellGainR.gain.setTargetAtTime(bellGainRValue, now, rampTime);
      if (nodes.frontGainC) {
        nodes.frontGainC.gain.setTargetAtTime(ampC * gainMultiplier * blendC.front, now, rampTime);
      }
      if (nodes.bellGainC) {
        nodes.bellGainC.gain.setTargetAtTime(ampC * gainMultiplier * blendC.bell, now, rampTime);
      }

      const noiseFrontDb = this.getNoiseFloorForMic(track, track.primaryMicPosition);
      const noiseBellDb = this.getNoiseFloorForMic(track, '8');
      const noiseFront = dbToLinear(noiseFrontDb);
      const noiseBell = dbToLinear(noiseBellDb);
      const noiseL = Math.sqrt(
        Math.pow(Math.abs(frontGainLValue) * noiseFront, 2) +
        Math.pow(Math.abs(bellGainLValue) * noiseBell, 2)
      );
      nodes.visualNoiseFloorDb = linearToDb(noiseL);
    } else {
      // No instrument directivity: apply mic polar pattern gain directly
      const gainLValue = ampL * gainMultiplier;
      const gainRValue = ampR * gainMultiplier;
      nodes.frontGainL.gain.setTargetAtTime(gainLValue, now, rampTime);
      nodes.frontGainR.gain.setTargetAtTime(gainRValue, now, rampTime);
      if (nodes.frontGainC) {
        nodes.frontGainC.gain.setTargetAtTime(ampC * gainMultiplier, now, rampTime);
      }

      const noiseDb = this.getNoiseFloorForMic(track, track.primaryMicPosition);
      const noiseL = Math.abs(gainLValue) * dbToLinear(noiseDb);
      nodes.visualNoiseFloorDb = linearToDb(noiseL);
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

        // Ground reflection delay must include baseDelay + ITD so it arrives AFTER direct sound
        // Direct sound uses: baseDelay + itdL/itdR
        // Ground reflection is extra path time (groundTime - directTime) on top of that
        const groundExtraL = Math.max(0, groundTimeL - delayL);
        const groundExtraR = Math.max(0, groundTimeR - delayR);
        nodes.groundDelayL.delayTime.setTargetAtTime(baseDelay + itdL + groundExtraL, now, rampTime);
        nodes.groundDelayR.delayTime.setTargetAtTime(baseDelay + itdR + groundExtraR, now, rampTime);

        // Convert from direct-path attenuation to ground-path using pure 1/d law
        // Both paths use unclamped inverse distance for accurate physics
        // Ratio = groundGain / directGain = effectiveDist / groundDist
        const refDist = 3; // Must match microphone-math.js refDistance
        const directGainL = refDist / effectiveDistL;
        const directGainR = refDist / effectiveDistR;
        const groundGainL = refDist / groundDistL;
        const groundGainR = refDist / groundDistR;

        // Apply polar pattern gain for ground reflection (mirror source angle)
        // Reflected sound comes from below ground - different incidence angle than direct
        const groundPolarL = calculateGroundReflectionPolarGain(
          this.micLPattern, sourcePosMeters, this.micL, this.micLAngle,
          STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );
        const groundPolarR = calculateGroundReflectionPolarGain(
          this.micRPattern, sourcePosMeters, this.micR, this.micRAngle,
          STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );

        // Combined amplitude: distance ratio * reflection polar ratio
        const patternRatioL = groundPolarL / safePatternGain(directPatternL);
        const patternRatioR = groundPolarR / safePatternGain(directPatternR);
        const baseAmpL = (groundGainL / directGainL) * patternRatioL;
        const baseAmpR = (groundGainR / directGainR) * patternRatioR;
        nodes.groundBaseGainL.gain.setTargetAtTime(baseAmpL, now, rampTime);
        nodes.groundBaseGainR.gain.setTargetAtTime(baseAmpR, now, rampTime);

        // Update air absorption for ground reflection (longer path = more HF loss)
        if (nodes.groundAirAbsorbL) {
          const groundAbsorptionL = this.calculateAirAbsorption(groundDistL);
          nodes.groundAirAbsorbL.forEach((filter, i) => {
            filter.gain.setTargetAtTime(groundAbsorptionL[i].gainDb, now, rampTime);
          });
        }
        if (nodes.groundAirAbsorbR) {
          const groundAbsorptionR = this.calculateAirAbsorption(groundDistR);
          nodes.groundAirAbsorbR.forEach((filter, i) => {
            filter.gain.setTargetAtTime(groundAbsorptionR[i].gainDb, now, rampTime);
          });
        }

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
          const directGainC = refDist / effectiveDistC;
          const groundGainC = refDist / groundDistC;
          const groundPolarC = calculateGroundReflectionPolarGain(
            this.micCPattern, sourcePosMeters, this.micC, this.micCAngle,
            STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
          );
          const patternRatioC = groundPolarC / safePatternGain(directPatternC);
          const baseAmpC = (groundGainC / directGainC) * patternRatioC;

          nodes.groundDelayC.delayTime.setTargetAtTime(baseDelay + itdC + groundExtraC, now, rampTime);
          nodes.groundBaseGainC.gain.setTargetAtTime(baseAmpC, now, rampTime);
          if (nodes.groundAirAbsorbC) {
            const groundAbsorptionC = this.calculateAirAbsorption(groundDistC);
            nodes.groundAirAbsorbC.forEach((filter, i) => {
              filter.gain.setTargetAtTime(groundAbsorptionC[i].gainDb, now, rampTime);
            });
          }
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

    const nodeMaps = [this.trackNodes, this.pendingTrackNodes].filter(Boolean);
    for (const nodeMap of nodeMaps) {
      const nodes = nodeMap.get(id);
      if (nodes) {
        this.updateTrackAudioParams(id, track, nodes);
      }
    }
  }

  /**
   * Update track mute state
   */
  updateTrackMuted(id, muted) {
    const track = this.tracks.get(id);
    if (!track) return;

    track.muted = muted;

    const nodeMaps = [this.trackNodes, this.pendingTrackNodes].filter(Boolean);
    for (const nodeMap of nodeMaps) {
      const nodes = nodeMap.get(id);
      if (nodes) {
        this.updateTrackAudioParams(id, track, nodes);
      }
    }
  }

  /**
   * Update track solo state
   */
  updateTrackSolo(id, solo) {
    const track = this.tracks.get(id);
    if (!track) return;

    const wasSolo = track.solo;
    track.solo = solo;

    if (wasSolo !== solo) {
      this.soloCount += solo ? 1 : -1;
      this.soloCount = Math.max(0, this.soloCount);
      this.hasSolo = this.soloCount > 0;
    }

    // Update all tracks since solo affects others
    this._updateAllTracks();
  }

  /**
   * Update track audio buffer (for noise gate re-processing)
   */
  updateTrackBuffer(id, newBuffer, options = {}) {
    const track = this.tracks.get(id);
    if (!track) return;

    track.buffer = newBuffer;

    // Update duration if needed
    if (newBuffer.duration > this.duration) {
      this.duration = newBuffer.duration;
    }

    // If playing, rebuild graph with crossfade unless deferred
    if (this.isPlaying) {
      if (options.deferRebuild) return;
      this.scheduleGraphRebuild({ delayMs: 0 });
    }
  }

  /**
   * Update track directivity buffers (for noise gate re-processing)
   */
  updateTrackDirectivityBuffers(id, alternateBuffers, options = {}) {
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

    if (this.isPlaying) {
      if (options.deferRebuild) return;
      this.scheduleGraphRebuild({ delayMs: 0 });
    }
  }

  /**
   * Set master gain
   */
  setMasterGain(gain) {
    this.masterGain = gain;
    if (this.masterGainNode) {
      const now = this.context ? this.context.currentTime : 0;
      const param = this.masterGainNode.gain;
      if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(now);
      } else {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
      }
      param.setTargetAtTime(gain, now, PARAM_RAMP_SECONDS);
    }
  }

  /**
   * Set reverb preset
   */
  setReverbPreset(preset, impulseBuffer, wetLevel = 0.3) {
    this.reverbPreset = preset;
    this.reverbPresetWet = wetLevel;
    this.reverbMix = this.reverbPresetWet * this.reverbWet;
    this.reverbImpulseBuffer = preset === 'none' ? null : impulseBuffer || null;

    if (this.isPlaying) {
      this.scheduleGraphRebuild({
        mode: 'overlap',
        duration: TOGGLE_CROSSFADE_SECONDS,
      });
    } else {
      this._applyReverbToBus(this.activeBus);
    }

    this.updateReverbSendLevels();
  }

  /**
   * Set reverb mode
   */
  setReverbMode(mode) {
    this.reverbMode = mode;

    this.updateReverbSendLevels();
  }

  /**
   * Set global reverb wet amount (scales preset wet)
   */
  setReverbWet(wet) {
    this.reverbWet = Math.max(0, Math.min(1, wet));
    this.reverbMix = this.reverbPresetWet * this.reverbWet;
    this.updateReverbSendLevels();
  }

  /**
   * Update all reverb send gains
   */
  updateReverbSendLevels() {
    const now = this.context ? this.context.currentTime : 0;
    const nodeMaps = [this.trackNodes, this.pendingTrackNodes].filter(Boolean);
    for (const nodeMap of nodeMaps) {
      for (const [id, track] of this.tracks) {
        const nodes = nodeMap.get(id);
        if (nodes && nodes.reverbSendL && nodes.reverbSendR) {
          const reverbLevel = this.calculateReverbSend(track.y);
          nodes.reverbSendL.gain.setTargetAtTime(reverbLevel, now, PARAM_RAMP_SECONDS);
          nodes.reverbSendR.gain.setTargetAtTime(reverbLevel, now, PARAM_RAMP_SECONDS);
          if (nodes.reverbSendC) {
            nodes.reverbSendC.gain.setTargetAtTime(reverbLevel * CENTER_PAN_GAIN, now, PARAM_RAMP_SECONDS);
          }
        }
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
  connectTrack(id, offset = 0, bus = this.activeBus, nodeMap = this.trackNodes) {
    const track = this.tracks.get(id);
    if (!track) return;

    if (!bus) {
      this.activeBus = this._createBus({ initialGain: 1 });
      bus = this.activeBus;
    }

    const hasDirectivity = track.frontBuffer && track.bellBuffer;
    const technique = STEREO_TECHNIQUES[this.micConfig.technique];
    const hasCenter = technique?.hasCenter;

    // Clamp offset to buffer duration to prevent WebAudio errors
    let maxOffset = 0;
    if (hasDirectivity) {
      const frontDuration = track.frontBuffer ? track.frontBuffer.duration : 0;
      const bellDuration = track.bellBuffer ? track.bellBuffer.duration : frontDuration;
      maxOffset = Math.min(frontDuration, bellDuration);
    } else {
      maxOffset = track.buffer ? track.buffer.duration : 0;
    }
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

    // === ANALYSER NODE for real-time level metering ===
    // Used for visual animation (pulse/glow when playing)
    const analyser = this.context.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;  // Larger window for stable RMS (~43ms at 48kHz)
    analyser.smoothingTimeConstant = 0.3;  // Smooth transitions
    // Tap the left mixer for level analysis (doesn't interrupt signal flow)
    mixerL.connect(analyser);

    const analyserFloatData = typeof analyser.getFloatTimeDomainData === 'function'
      ? new Float32Array(analyser.fftSize)
      : null;
    const analyserByteData = analyserFloatData ? null : new Uint8Array(analyser.fftSize);

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
    prevNodeL.connect(bus.stereoMerger, 0, 0); // Left channel

    mixerR.connect(delayR);
    // Chain the R filter bank
    let prevNodeR = delayR;
    for (const filter of airAbsorbR) {
      prevNodeR.connect(filter);
      prevNodeR = filter;
    }
    prevNodeR.connect(bus.stereoMerger, 0, 1); // Right channel

    // === CENTER MIC CHAIN (Decca Tree) ===
    let delayC = null;
    let airAbsorbC = null;
    let centerBus = null;
    let prevNodeC = null;

    if (hasCenter && mixerC) {
      delayC = this.context.createDelay(0.1);
      airAbsorbC = this.createAirAbsorptionFilterBank(this.context);

      mixerC.connect(delayC);
      prevNodeC = delayC;
      for (const filter of airAbsorbC) {
        prevNodeC.connect(filter);
        prevNodeC = filter;
      }

      centerBus = this.context.createGain();
      centerBus.gain.value = CENTER_PAN_GAIN;
      prevNodeC.connect(centerBus);
      centerBus.connect(bus.stereoMerger, 0, 0);
      centerBus.connect(bus.stereoMerger, 0, 1);
    }

    // === GROUND REFLECTION (optional) ===
    let groundBaseGainL, groundDelayL, groundAirAbsorbL, groundLowFilterL, groundHighFilterL, groundLowGainL, groundHighGainL, groundSumL;
    let groundBaseGainR, groundDelayR, groundAirAbsorbR, groundLowFilterR, groundHighFilterR, groundLowGainR, groundHighGainR, groundSumR;
    let groundBaseGainC, groundDelayC, groundAirAbsorbC, groundLowFilterC, groundHighFilterC, groundLowGainC, groundHighGainC, groundSumC;

    if (this.groundReflectionEnabled) {
      const groundModel = this.getGroundReflectionModelConfig();

      groundBaseGainL = this.context.createGain();
      groundDelayL = this.context.createDelay(0.1);
      groundAirAbsorbL = this.createAirAbsorptionFilterBank(this.context);
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
      groundAirAbsorbR = this.createAirAbsorptionFilterBank(this.context);
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
      // Chain: mixer → baseGain → delay → airAbsorb[0..6] → low/high split → sum → output
      mixerL.connect(groundBaseGainL);
      groundBaseGainL.connect(groundDelayL);
      // Chain air absorption filters for ground path
      let prevGroundL = groundDelayL;
      for (const filter of groundAirAbsorbL) {
        prevGroundL.connect(filter);
        prevGroundL = filter;
      }
      prevGroundL.connect(groundLowFilterL);
      groundLowFilterL.connect(groundLowGainL);
      groundLowGainL.connect(groundSumL);
      prevGroundL.connect(groundHighFilterL);
      groundHighFilterL.connect(groundHighGainL);
      groundHighGainL.connect(groundSumL);
      groundSumL.connect(bus.stereoMerger, 0, 0);

      mixerR.connect(groundBaseGainR);
      groundBaseGainR.connect(groundDelayR);
      // Chain air absorption filters for ground path
      let prevGroundR = groundDelayR;
      for (const filter of groundAirAbsorbR) {
        prevGroundR.connect(filter);
        prevGroundR = filter;
      }
      prevGroundR.connect(groundLowFilterR);
      groundLowFilterR.connect(groundLowGainR);
      groundLowGainR.connect(groundSumR);
      prevGroundR.connect(groundHighFilterR);
      groundHighFilterR.connect(groundHighGainR);
      groundHighGainR.connect(groundSumR);
      groundSumR.connect(bus.stereoMerger, 0, 1);

      if (hasCenter && mixerC && centerBus) {
        groundBaseGainC = this.context.createGain();
        groundDelayC = this.context.createDelay(0.1);
        groundAirAbsorbC = this.createAirAbsorptionFilterBank(this.context);
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
        // Chain air absorption filters for ground path
        let prevGroundC = groundDelayC;
        for (const filter of groundAirAbsorbC) {
          prevGroundC.connect(filter);
          prevGroundC = filter;
        }
        prevGroundC.connect(groundLowFilterC);
        groundLowFilterC.connect(groundLowGainC);
        groundLowGainC.connect(groundSumC);
        prevGroundC.connect(groundHighFilterC);
        groundHighFilterC.connect(groundHighGainC);
        groundHighGainC.connect(groundSumC);
        groundSumC.connect(centerBus);
      }
    }

    // === REVERB SEND (post-distance/absorption for realistic depth) ===
    const reverbSendL = this.context.createGain();
    const reverbSendR = this.context.createGain();
    const reverbMerger = this.context.createChannelMerger(2);
    prevNodeL.connect(reverbSendL);
    prevNodeR.connect(reverbSendR);
    reverbSendL.connect(reverbMerger, 0, 0);
    reverbSendR.connect(reverbMerger, 0, 1);
    let reverbSendC = null;
    if (hasCenter && prevNodeC) {
      reverbSendC = this.context.createGain();
      prevNodeC.connect(reverbSendC);
      reverbSendC.connect(reverbMerger, 0, 0);
      reverbSendC.connect(reverbMerger, 0, 1);
    }
    reverbMerger.connect(bus.reverbNode);

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
      analyser,  // For real-time level metering
      analyserFloatData,
      analyserByteData,
      delayL,
      delayR,
      delayC,
      airAbsorbL,
      airAbsorbR,
      airAbsorbC,
      centerBus,
      groundBaseGainL,
      groundDelayL,
      groundAirAbsorbL,
      groundLowFilterL,
      groundHighFilterL,
      groundLowGainL,
      groundHighGainL,
      groundSumL,
      groundBaseGainR,
      groundDelayR,
      groundAirAbsorbR,
      groundLowFilterR,
      groundHighFilterR,
      groundLowGainR,
      groundHighGainR,
      groundSumR,
      groundBaseGainC,
      groundDelayC,
      groundAirAbsorbC,
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
      isSuperseded: false,
    };

    nodeMap.set(id, nodes);

    // Set initial parameters
    this.updateTrackAudioParams(id, track, nodes);

    // Start playback
    sourceFront.start(0, offset);
    if (sourceBell) {
      sourceBell.start(0, offset);
    }

    // Handle playback end
    const nodeMapRef = nodeMap;
    sourceFront.onended = () => {
      nodes.ended = true;
      if (nodes.isSuperseded) return;
      if (nodeMapRef !== this.trackNodes) return;
      if (!this.isPlaying) return;

      const allEnded = Array.from(nodeMapRef.values()).every(n => {
        return !n.sourceFront.buffer || n.ended;
      });

      if (allEnded && this.onPlaybackEnd) {
        this.onPlaybackEnd();
      }
    };
  }

  /**
   * Disconnect audio nodes for a track
   */
  disconnectTrack(id, nodeMap = this.trackNodes) {
    const nodes = nodeMap.get(id);
    if (!nodes) return;

    this._disconnectTrackNodes(nodes);
    nodeMap.delete(id);
  }

  /**
   * Get real-time master output level in dBFS (pre-limiter)
   * @returns {number} RMS level in dBFS or -Infinity if silent/idle
   */
  getMasterLevelDb() {
    if (!this.masterAnalyser || !this.context) return -Infinity;
    if (!this.isPlaying) return -Infinity;

    const playbackTime = this.context.currentTime - this.startTime;
    if (playbackTime < MASTER_METER_WARMUP_SECONDS) return -Infinity;

    const analyser = this.masterAnalyser;
    let sumSquares = 0;
    let sampleCount = 0;

    if (this.masterAnalyserFloatData && typeof analyser.getFloatTimeDomainData === 'function') {
      if (this.masterAnalyserFloatData.length !== analyser.fftSize) {
        this.masterAnalyserFloatData = new Float32Array(analyser.fftSize);
      }
      analyser.getFloatTimeDomainData(this.masterAnalyserFloatData);
      sampleCount = this.masterAnalyserFloatData.length;
      for (let i = 0; i < sampleCount; i++) {
        const v = this.masterAnalyserFloatData[i];
        sumSquares += v * v;
      }
    } else {
      if (!this.masterAnalyserByteData || this.masterAnalyserByteData.length !== analyser.fftSize) {
        this.masterAnalyserByteData = new Uint8Array(analyser.fftSize);
      }
      analyser.getByteTimeDomainData(this.masterAnalyserByteData);
      sampleCount = this.masterAnalyserByteData.length;
      for (let i = 0; i < sampleCount; i++) {
        const v = (this.masterAnalyserByteData[i] - 128) / 128;
        sumSquares += v * v;
      }
    }

    if (!sampleCount) return -Infinity;
    const rms = Math.sqrt(sumSquares / sampleCount);
    if (!Number.isFinite(rms) || rms <= 0) return -Infinity;
    return 20 * Math.log10(rms);
  }

  /**
   * Get real-time audio level for a track (0..1 range)
   * Uses RMS detection with per-track noise floor gating
   * @param {string} trackId - Track identifier
   * @returns {number} Level from 0 (silent) to 1 (loud)
   */
  getTrackLevel(trackId) {
    const nodes = this.trackNodes.get(trackId);
    if (!nodes || !nodes.analyser) return 0;

    // Only return levels if actually playing
    if (!this.isPlaying) return 0;

    // Wait for audio to actually be flowing before reporting levels
    // AnalyserNode buffers contain uninitialized/stale data initially
    const playbackTime = this.context.currentTime - this.startTime;
    if (playbackTime < 0.05) return 0;  // 50ms warmup for real audio data

    // Get time-domain data from analyser
    const analyser = nodes.analyser;
    let sumSquares = 0;
    let sampleCount = 0;

    if (nodes.analyserFloatData && typeof analyser.getFloatTimeDomainData === 'function') {
      if (nodes.analyserFloatData.length !== analyser.fftSize) {
        nodes.analyserFloatData = new Float32Array(analyser.fftSize);
      }
      analyser.getFloatTimeDomainData(nodes.analyserFloatData);
      const dataArray = nodes.analyserFloatData;
      sampleCount = dataArray.length;
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i];
        sumSquares += v * v;
      }
    } else {
      if (!nodes.analyserByteData || nodes.analyserByteData.length !== analyser.fftSize) {
        nodes.analyserByteData = new Uint8Array(analyser.fftSize);
      }
      analyser.getByteTimeDomainData(nodes.analyserByteData);
      const dataArray = nodes.analyserByteData;
      sampleCount = dataArray.length;
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128;  // -1..1 range
        sumSquares += v * v;
      }
    }

    // Compute RMS amplitude for stability (less jumpy than peaks)
    const rms = sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0;

    if (rms <= 0) return 0;

    const rmsDb = 20 * Math.log10(rms);
    const noiseFloorDb = Number.isFinite(nodes.visualNoiseFloorDb)
      ? nodes.visualNoiseFloorDb + VISUAL_NOISE_MARGIN_DB
      : DEFAULT_NOISE_FLOOR_DB + VISUAL_NOISE_MARGIN_DB;

    if (rmsDb <= noiseFloorDb) return 0;

    const normalized = Math.min(1, (rmsDb - noiseFloorDb) / VISUAL_DYNAMIC_RANGE_DB);

    // Apply curve to emphasize mid-range levels
    return Math.pow(normalized, 0.7);
  }

  /**
   * Get audio levels for all active tracks
   * @returns {Map<string, number>} Map of trackId -> level (0..1)
   */
  getAllTrackLevels() {
    const levels = new Map();
    for (const trackId of this.trackNodes.keys()) {
      levels.set(trackId, this.getTrackLevel(trackId));
    }
    return levels;
  }

  /**
   * Start playback
   */
  async play() {
    if (this.isPlaying) return;

    await this.resume();

    const offset = this.pauseOffset;

    if (!this.activeBus) {
      this.activeBus = this._createBus({ initialGain: 1 });
    } else {
      this.activeBus.outputGain.gain.value = 1;
    }

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
    this._cancelGraphRebuild();
    this._cancelCrossfade();
    this.graphRebuildPending = null;
    this.graphRebuildQueued = null;
    this.graphRebuildInProgress = false;

    this._disconnectTrackMap(this.trackNodes);
    this._disconnectTrackMap(this.pendingTrackNodes);
    this.pendingTrackNodes = null;

    for (const timerId of this.busDisposeTimers) {
      clearTimeout(timerId);
    }
    this.busDisposeTimers.clear();

    if (this.pendingBus) {
      this._disconnectBus(this.pendingBus);
      this.pendingBus = null;
    }

    this.isPlaying = false;

    if (resetPosition) {
      this.pauseOffset = 0;
    }

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    if (this.activeBus) {
      this.activeBus.outputGain.gain.value = 1;
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
   * Render the mix offline with configurable options.
   */
  async _renderOfflineMix({ sampleRate, masterGain, includeLimiter, onProgress, signal }) {
    const targetSampleRate = sampleRate || (this.context ? this.context.sampleRate : 44100);
    const length = Math.ceil(this.duration * targetSampleRate);
    const offlineContext = new OfflineAudioContext(2, length, targetSampleRate);

    const masterGainValue = Number.isFinite(masterGain) ? masterGain : this.masterGain;
    let masterDestination = offlineContext.destination;

    if (includeLimiter) {
      // Create master limiter (matches realtime chain)
      const masterLimiter = offlineContext.createDynamicsCompressor();
      masterLimiter.threshold.value = -1;
      masterLimiter.knee.value = 0;
      masterLimiter.ratio.value = 20;
      masterLimiter.attack.value = 0.001;
      masterLimiter.release.value = 0.05;
      masterLimiter.connect(offlineContext.destination);
      masterDestination = masterLimiter;
    }

    // Create master gain
    const masterGainNode = offlineContext.createGain();
    masterGainNode.gain.value = masterGainValue;
    masterGainNode.connect(masterDestination);

    // Create stereo merger
    const stereoMerger = offlineContext.createChannelMerger(2);
    stereoMerger.connect(masterGainNode);

    // Create reverb
    let reverbConvolver = null;
    const reverbGain = offlineContext.createGain();
    reverbGain.gain.value = this.reverbPreset === 'none' ? 0 : 1;
    reverbGain.connect(masterGainNode);

    if (this.reverbImpulseBuffer && this.reverbPreset !== 'none') {
      reverbConvolver = offlineContext.createConvolver();
      reverbConvolver.buffer = this.reverbImpulseBuffer;
      reverbConvolver.connect(reverbGain);
    }

    const hasSolo = this.hasSolo;
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
      const directPatternL = responseL?.patternGain ?? 1;
      const directPatternR = responseR?.patternGain ?? 1;
      const directPatternC = responseC?.patternGain ?? 1;

      // Use stereo response delays
      const timeL = responseL?.delay ?? stereoResponse.left.delay;
      const timeR = responseR?.delay ?? stereoResponse.right.delay;
      const timeC = responseC?.delay ?? null;

      // Get distances from stereo response for air absorption
      const distL = responseL?.distance || 3;
      const distR = responseR?.distance || 3;
      const distC = responseC?.distance || 3;

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
      let prevC = null;
      if (hasCenter && mixerC) {
        const delayC = offlineContext.createDelay(0.1);
        delayC.delayTime.value = baseDelay + itdC;
        const absorbC = this.createAirAbsorptionFilterBank(offlineContext);
        const absorptionC = this.calculateAirAbsorption(distC);
        absorbC.forEach((filter, i) => { filter.gain.value = absorptionC[i].gainDb; });
        mixerC.connect(delayC);
        prevC = delayC;
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
        const refDist = 3; // Must match microphone-math.js refDistance

        // Convert from direct-path attenuation to ground-path using pure 1/d law
        // Ratio = groundGain / directGain = distL / groundDistL
        const directGainL = refDist / distL;
        const groundGainL = refDist / groundDistL;
        // Apply polar pattern gain for ground reflection (mirror source angle)
        const groundPolarL = calculateGroundReflectionPolarGain(
          this.micLPattern, sourcePos, this.micL, this.micLAngle,
          STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );
        const patternRatioL = groundPolarL / safePatternGain(directPatternL);
        const baseAmpL = (groundGainL / directGainL) * patternRatioL;
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

        // Air absorption for ground reflection (longer path = more HF loss)
        const groundAbsorbL = this.createAirAbsorptionFilterBank(offlineContext);
        const groundAbsorptionL = this.calculateAirAbsorption(groundDistL);
        groundAbsorbL.forEach((filter, i) => { filter.gain.value = groundAbsorptionL[i].gainDb; });

        // Chain: mixer → baseGain → delay → airAbsorb[0..6] → low/high split → sum → output
        mixerL.connect(groundBaseGainL);
        groundBaseGainL.connect(groundDelayL);
        let prevGroundL = groundDelayL;
        for (const filter of groundAbsorbL) {
          prevGroundL.connect(filter);
          prevGroundL = filter;
        }
        prevGroundL.connect(groundLowFilterL);
        groundLowFilterL.connect(groundLowGainL);
        groundLowGainL.connect(groundSumL);
        prevGroundL.connect(groundHighFilterL);
        groundHighFilterL.connect(groundHighGainL);
        groundHighGainL.connect(groundSumL);
        groundSumL.connect(stereoMerger, 0, 0);

        const directGainR = refDist / distR;
        const groundGainR = refDist / groundDistR;
        const groundPolarR = calculateGroundReflectionPolarGain(
          this.micRPattern, sourcePos, this.micR, this.micRAngle,
          STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );
        const patternRatioR = groundPolarR / safePatternGain(directPatternR);
        const baseAmpR = (groundGainR / directGainR) * patternRatioR;
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

        // Air absorption for ground reflection R
        const groundAbsorbR = this.createAirAbsorptionFilterBank(offlineContext);
        const groundAbsorptionR = this.calculateAirAbsorption(groundDistR);
        groundAbsorbR.forEach((filter, i) => { filter.gain.value = groundAbsorptionR[i].gainDb; });

        mixerR.connect(groundBaseGainR);
        groundBaseGainR.connect(groundDelayR);
        let prevGroundR = groundDelayR;
        for (const filter of groundAbsorbR) {
          prevGroundR.connect(filter);
          prevGroundR = filter;
        }
        prevGroundR.connect(groundLowFilterR);
        groundLowFilterR.connect(groundLowGainR);
        groundLowGainR.connect(groundSumR);
        prevGroundR.connect(groundHighFilterR);
        groundHighFilterR.connect(groundHighGainR);
        groundHighGainR.connect(groundSumR);
        groundSumR.connect(stereoMerger, 0, 1);

        if (hasCenter && mixerC && centerBus && this.micC && timeC !== null) {
          const groundDistC = this.calculateGroundReflectionDistance(
            sourcePos, this.micC, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
          );
          const groundTimeC = groundDistC / SPEED_OF_SOUND;
          const groundExtraC = Math.max(0, groundTimeC - timeC);

          const directGainC = refDist / distC;
          const groundGainC = refDist / groundDistC;
          const groundPolarC = calculateGroundReflectionPolarGain(
            this.micCPattern, sourcePos, this.micC, this.micCAngle,
            STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
          );
          const patternRatioC = groundPolarC / safePatternGain(directPatternC);
          const baseAmpC = (groundGainC / directGainC) * patternRatioC;
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

          // Air absorption for ground reflection C
          const groundAbsorbC = this.createAirAbsorptionFilterBank(offlineContext);
          const groundAbsorptionC = this.calculateAirAbsorption(groundDistC);
          groundAbsorbC.forEach((filter, i) => { filter.gain.value = groundAbsorptionC[i].gainDb; });

          mixerC.connect(groundBaseGainC);
          groundBaseGainC.connect(groundDelayC);
          let prevGroundC = groundDelayC;
          for (const filter of groundAbsorbC) {
            prevGroundC.connect(filter);
            prevGroundC = filter;
          }
          prevGroundC.connect(groundLowFilterC);
          groundLowFilterC.connect(groundLowGainC);
          groundLowGainC.connect(groundSumC);
          prevGroundC.connect(groundHighFilterC);
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
        prevL.connect(reverbSendL);
        prevR.connect(reverbSendR);
        if (reverbSendC && prevC) {
          prevC.connect(reverbSendC);
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
   * Render the mix offline for export
   */
  async renderOffline(onProgress, signal) {
    const sampleRate = this.context ? this.context.sampleRate : 44100;
    return this._renderOfflineMix({
      sampleRate,
      masterGain: this.masterGain,
      includeLimiter: true,
      onProgress,
      signal,
    });
  }

  /**
   * Analyze mix loudness using a low-res offline render.
   */
  async analyzeMixLoudness({
    sampleRate = 22050,
    windowMs = 200,
    percentile = 0.95,
    minDb = -80,
    onProgress,
    signal,
  } = {}) {
    const buffer = await this._renderOfflineMix({
      sampleRate,
      masterGain: 1,
      includeLimiter: false,
      onProgress,
      signal,
    });

    return this._calculateBufferLoudness(buffer, { windowMs, percentile, minDb });
  }

  _calculateBufferLoudness(buffer, { windowMs, percentile, minDb }) {
    const sampleRate = buffer.sampleRate;
    const windowSamples = Math.max(1, Math.floor(sampleRate * windowMs / 1000));
    const channelCount = buffer.numberOfChannels;
    const left = buffer.getChannelData(0);
    const right = channelCount > 1 ? buffer.getChannelData(1) : left;
    const length = buffer.length;

    const rmsValues = [];
    let sumSquares = 0;
    let sampleCount = 0;
    let peak = 0;

    for (let i = 0; i < length; i++) {
      const l = left[i];
      const r = right[i];
      const power = 0.5 * (l * l + r * r);
      sumSquares += power;
      sampleCount += 1;

      const abs = Math.max(Math.abs(l), Math.abs(r));
      if (abs > peak) peak = abs;

      if (sampleCount === windowSamples) {
        const rms = Math.sqrt(sumSquares / sampleCount);
        if (rms > 0) {
          const db = 20 * Math.log10(rms);
          if (db >= minDb) {
            rmsValues.push(db);
          }
        }
        sumSquares = 0;
        sampleCount = 0;
      }
    }

    if (sampleCount > 0) {
      const rms = Math.sqrt(sumSquares / sampleCount);
      if (rms > 0) {
        const db = 20 * Math.log10(rms);
        if (db >= minDb) {
          rmsValues.push(db);
        }
      }
    }

    if (rmsValues.length === 0) {
      return {
        windowCount: 0,
        percentileDb: -Infinity,
        peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      };
    }

    rmsValues.sort((a, b) => a - b);
    const clampedPercentile = Math.max(0, Math.min(1, percentile));
    const index = Math.floor(clampedPercentile * (rmsValues.length - 1));
    const percentileDb = rmsValues[index];

    return {
      windowCount: rmsValues.length,
      percentileDb,
      peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    };
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
