// Web Audio API engine with physically accurate stereo simulation
// Features: ITD, 1/d amplitude, frequency-dependent air absorption, optional ground reflection

// Physical constants
const SPEED_OF_SOUND = 343; // m/s at 20°C

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

    this.onTimeUpdate = null;
    this.onPlaybackEnd = null;
    this.animationFrame = null;

    // Virtual microphone positions (meters)
    this.micL = { x: -STAGE_CONFIG.micSpacing / 2, y: STAGE_CONFIG.micY };
    this.micR = { x: STAGE_CONFIG.micSpacing / 2, y: STAGE_CONFIG.micY };
  }

  /**
   * Initialize the audio context
   */
  async init() {
    if (this.context) return;

    this.context = new (window.AudioContext || window.webkitAudioContext)();

    // Create master output chain
    this.masterGainNode = this.context.createGain();
    this.masterGainNode.gain.value = this.masterGain;
    this.masterGainNode.connect(this.context.destination);

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
   * Calculate distance between two points
   */
  calculateDistance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Calculate 3D distance including height for ground reflection
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
   * Set mic separation (DECCA-style, tied on Y axis)
   * @param {number} separation - Total separation in meters (L and R are ±separation/2 from center)
   */
  setMicSeparation(separation) {
    const halfSep = separation / 2;
    this.micL.x = -halfSep;
    this.micR.x = halfSep;

    // Update all track audio params to reflect new mic positions
    for (const [id, track] of this.tracks) {
      const nodes = this.trackNodes.get(id);
      if (nodes) {
        this.updateTrackAudioParams(id, track, nodes);
      }
    }
  }

  /**
   * Get current mic separation
   */
  getMicSeparation() {
    return Math.abs(this.micR.x - this.micL.x);
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
   */
  updateTrackAudioParams(id, track, nodes) {
    const sourcePos = this.normalizedToMeters(track.x, track.y);

    // Calculate distances to each mic
    const distL = this.calculateDistance(sourcePos, this.micL);
    const distR = this.calculateDistance(sourcePos, this.micR);

    // Minimum distance to avoid division by zero and extreme values
    const minDist = 0.5;
    const effectiveDistL = Math.max(distL, minDist);
    const effectiveDistR = Math.max(distR, minDist);

    // 1/d amplitude falloff (capped at 1.0 to prevent clipping)
    const refDist = 3; // Reference distance for unity gain
    const ampL = Math.min(1.0, refDist / effectiveDistL);
    const ampR = Math.min(1.0, refDist / effectiveDistR);

    // Apply track gain and mute/solo
    const hasSolo = Array.from(this.tracks.values()).some(t => t.solo);
    let gainMultiplier = track.gain;
    if (track.muted || (hasSolo && !track.solo)) {
      gainMultiplier = 0;
    }

    // === DIRECTIVITY BLENDING ===
    // Calculate blend weights for each channel based on angle to mic
    const blendL = this.calculateDirectivityBlend(sourcePos, this.micL);
    const blendR = this.calculateDirectivityBlend(sourcePos, this.micR);

    // Use setTargetAtTime for smooth transitions to avoid zipper noise during dragging
    const now = this.context.currentTime;
    const rampTime = 0.02; // 20ms ramp for smooth transitions

    if (nodes.hasDirectivity) {
      // Apply directivity: front and bell sources are blended per channel
      // Front gain includes amplitude + directivity front weight
      nodes.frontGainL.gain.setTargetAtTime(ampL * gainMultiplier * blendL.front, now, rampTime);
      nodes.frontGainR.gain.setTargetAtTime(ampR * gainMultiplier * blendR.front, now, rampTime);
      // Bell gain includes amplitude + directivity bell weight
      nodes.bellGainL.gain.setTargetAtTime(ampL * gainMultiplier * blendL.bell, now, rampTime);
      nodes.bellGainR.gain.setTargetAtTime(ampR * gainMultiplier * blendR.bell, now, rampTime);
    } else {
      // No directivity: front source only, apply amplitude directly
      nodes.frontGainL.gain.setTargetAtTime(ampL * gainMultiplier, now, rampTime);
      nodes.frontGainR.gain.setTargetAtTime(ampR * gainMultiplier, now, rampTime);
    }

    // ITD - delay based on distance difference
    // We delay the further channel relative to the closer one
    const timeL = effectiveDistL / SPEED_OF_SOUND;
    const timeR = effectiveDistR / SPEED_OF_SOUND;
    const minTime = Math.min(timeL, timeR);

    nodes.delayL.delayTime.setTargetAtTime(timeL - minTime, now, rampTime);
    nodes.delayR.delayTime.setTargetAtTime(timeR - minTime, now, rampTime);

    // Air absorption - update high shelf filters
    const absorbL = this.calculateAirAbsorptionDb(effectiveDistL);
    const absorbR = this.calculateAirAbsorptionDb(effectiveDistR);

    nodes.airAbsorbL.gain.setTargetAtTime(-absorbL, now, rampTime);
    nodes.airAbsorbR.gain.setTargetAtTime(-absorbR, now, rampTime);

    // Ground reflection (if enabled and nodes exist)
    if (nodes.groundDelayL && nodes.groundGainL) {
      if (this.groundReflectionEnabled) {
        const groundDistL = this.calculateGroundReflectionDistance(
          sourcePos, this.micL, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );
        const groundDistR = this.calculateGroundReflectionDistance(
          sourcePos, this.micR, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );

        const groundTimeL = groundDistL / SPEED_OF_SOUND;
        const groundTimeR = groundDistR / SPEED_OF_SOUND;

        // Delay relative to direct sound
        nodes.groundDelayL.delayTime.setTargetAtTime(groundTimeL - timeL, now, rampTime);
        nodes.groundDelayR.delayTime.setTargetAtTime(groundTimeR - timeR, now, rampTime);

        // Ground reflection amplitude (1/d with reflection coefficient)
        const groundAmpL = (refDist / groundDistL) * STAGE_CONFIG.groundReflectionCoeff;
        const groundAmpR = (refDist / groundDistR) * STAGE_CONFIG.groundReflectionCoeff;

        nodes.groundGainL.gain.setTargetAtTime(groundAmpL * gainMultiplier, now, rampTime);
        nodes.groundGainR.gain.setTargetAtTime(groundAmpR * gainMultiplier, now, rampTime);
      } else {
        nodes.groundGainL.gain.setTargetAtTime(0, now, rampTime);
        nodes.groundGainR.gain.setTargetAtTime(0, now, rampTime);
      }
    }

    // Reverb send based on mode (stereo - L and R have same level)
    if (nodes.reverbSendL && nodes.reverbSendR) {
      const reverbLevel = this.calculateReverbSend(track.y);
      nodes.reverbSendL.gain.setTargetAtTime(reverbLevel, now, rampTime);
      nodes.reverbSendR.gain.setTargetAtTime(reverbLevel, now, rampTime);
    }
  }

  /**
   * Calculate simplified air absorption in dB for high-shelf filter
   * Approximates the complex frequency-dependent absorption
   */
  calculateAirAbsorptionDb(distance) {
    // Use 4kHz absorption as representative for high-shelf
    // ~2.8 dB per 100m at 4kHz
    return (2.8 * distance) / 100;
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
    let bellGainL = null;
    let bellGainR = null;

    if (hasDirectivity) {
      bellGainL = this.context.createGain();
      bellGainR = this.context.createGain();
    }

    // === CHANNEL MIXERS ===
    // Mix front+bell into single L and R signals
    const mixerL = this.context.createGain();
    const mixerR = this.context.createGain();

    // Connect front source to mixers via directivity gains
    sourceFront.connect(frontGainL);
    sourceFront.connect(frontGainR);
    frontGainL.connect(mixerL);
    frontGainR.connect(mixerR);

    // Connect bell source if available
    if (hasDirectivity) {
      sourceBell.connect(bellGainL);
      sourceBell.connect(bellGainR);
      bellGainL.connect(mixerL);
      bellGainR.connect(mixerR);
    }

    // === ITD DELAY AND AIR ABSORPTION ===
    const delayL = this.context.createDelay(0.1); // Max 100ms delay
    const delayR = this.context.createDelay(0.1);

    const airAbsorbL = this.context.createBiquadFilter();
    airAbsorbL.type = 'highshelf';
    airAbsorbL.frequency.value = 2000;
    airAbsorbL.gain.value = 0;

    const airAbsorbR = this.context.createBiquadFilter();
    airAbsorbR.type = 'highshelf';
    airAbsorbR.frequency.value = 2000;
    airAbsorbR.gain.value = 0;

    // Connect: mixer -> delay -> airAbsorb -> stereo merger
    mixerL.connect(delayL);
    delayL.connect(airAbsorbL);
    airAbsorbL.connect(this.stereoMerger, 0, 0); // Left channel

    mixerR.connect(delayR);
    delayR.connect(airAbsorbR);
    airAbsorbR.connect(this.stereoMerger, 0, 1); // Right channel

    // === GROUND REFLECTION (optional) ===
    let groundDelayL, groundGainL, groundFilterL;
    let groundDelayR, groundGainR, groundFilterR;

    if (this.groundReflectionEnabled) {
      groundGainL = this.context.createGain();
      groundDelayL = this.context.createDelay(0.1);
      groundFilterL = this.context.createBiquadFilter();
      groundFilterL.type = 'lowpass';
      groundFilterL.frequency.value = 8000;
      groundFilterL.Q.value = 0.5;

      groundGainR = this.context.createGain();
      groundDelayR = this.context.createDelay(0.1);
      groundFilterR = this.context.createBiquadFilter();
      groundFilterR.type = 'lowpass';
      groundFilterR.frequency.value = 8000;
      groundFilterR.Q.value = 0.5;

      // Ground reflection uses the mixed signal
      mixerL.connect(groundGainL);
      groundGainL.connect(groundDelayL);
      groundDelayL.connect(groundFilterL);
      groundFilterL.connect(this.stereoMerger, 0, 0);

      mixerR.connect(groundGainR);
      groundGainR.connect(groundDelayR);
      groundDelayR.connect(groundFilterR);
      groundFilterR.connect(this.stereoMerger, 0, 1);
    }

    // === REVERB SEND (stereo - preserve L/R separation) ===
    const reverbSendL = this.context.createGain();
    const reverbSendR = this.context.createGain();
    const reverbMerger = this.context.createChannelMerger(2);
    mixerL.connect(reverbSendL);
    mixerR.connect(reverbSendR);
    reverbSendL.connect(reverbMerger, 0, 0);
    reverbSendR.connect(reverbMerger, 0, 1);
    reverbMerger.connect(this.reverbNode);

    // Store nodes
    const nodes = {
      sourceFront,
      sourceBell,
      frontGainL,
      frontGainR,
      bellGainL,
      bellGainR,
      mixerL,
      mixerR,
      delayL,
      delayR,
      airAbsorbL,
      airAbsorbR,
      groundDelayL,
      groundDelayR,
      groundGainL,
      groundGainR,
      groundFilterL,
      groundFilterR,
      reverbSendL,
      reverbSendR,
      reverbMerger,
      hasDirectivity,
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

    // Create master gain
    const masterGain = offlineContext.createGain();
    masterGain.gain.value = this.masterGain;
    masterGain.connect(offlineContext.destination);

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

    for (const [, track] of this.tracks) {
      if (signal && signal.aborted) {
        throw new DOMException('Render cancelled', 'AbortError');
      }

      if (track.muted) continue;
      if (hasSolo && !track.solo) continue;

      const sourcePos = this.normalizedToMeters(track.x, track.y);
      const distL = Math.max(0.5, this.calculateDistance(sourcePos, this.micL));
      const distR = Math.max(0.5, this.calculateDistance(sourcePos, this.micR));

      const refDist = 3;
      // Limit gain to prevent clipping (cap at 1.0 for close sources)
      const ampL = Math.min(1.0, refDist / distL);
      const ampR = Math.min(1.0, refDist / distR);

      const timeL = distL / SPEED_OF_SOUND;
      const timeR = distR / SPEED_OF_SOUND;
      const minTime = Math.min(timeL, timeR);

      // Check for directivity blending
      const hasDirectivity = track.frontBuffer && track.bellBuffer;
      const blendL = this.calculateDirectivityBlend(sourcePos, this.micL);
      const blendR = this.calculateDirectivityBlend(sourcePos, this.micR);

      // Create mixer nodes for blending front/bell sources
      const mixerL = offlineContext.createGain();
      const mixerR = offlineContext.createGain();

      if (hasDirectivity) {
        // Front source
        const sourceFront = offlineContext.createBufferSource();
        sourceFront.buffer = track.frontBuffer;
        const frontGainL = offlineContext.createGain();
        const frontGainR = offlineContext.createGain();
        frontGainL.gain.value = ampL * track.gain * blendL.front;
        frontGainR.gain.value = ampR * track.gain * blendR.front;
        sourceFront.connect(frontGainL);
        sourceFront.connect(frontGainR);
        frontGainL.connect(mixerL);
        frontGainR.connect(mixerR);
        sourceFront.start(0);

        // Bell source
        const sourceBell = offlineContext.createBufferSource();
        sourceBell.buffer = track.bellBuffer;
        const bellGainL = offlineContext.createGain();
        const bellGainR = offlineContext.createGain();
        bellGainL.gain.value = ampL * track.gain * blendL.bell;
        bellGainR.gain.value = ampR * track.gain * blendR.bell;
        sourceBell.connect(bellGainL);
        sourceBell.connect(bellGainR);
        bellGainL.connect(mixerL);
        bellGainR.connect(mixerR);
        sourceBell.start(0);
      } else {
        // Single source (no directivity)
        const source = offlineContext.createBufferSource();
        source.buffer = track.buffer;
        const gainL = offlineContext.createGain();
        const gainR = offlineContext.createGain();
        gainL.gain.value = ampL * track.gain;
        gainR.gain.value = ampR * track.gain;
        source.connect(gainL);
        source.connect(gainR);
        gainL.connect(mixerL);
        gainR.connect(mixerR);
        source.start(0);
      }

      // Left channel processing
      const delayL = offlineContext.createDelay(0.1);
      delayL.delayTime.value = timeL - minTime;
      const absorbL = offlineContext.createBiquadFilter();
      absorbL.type = 'highshelf';
      absorbL.frequency.value = 2000;
      absorbL.gain.value = -this.calculateAirAbsorptionDb(distL);
      mixerL.connect(delayL);
      delayL.connect(absorbL);
      absorbL.connect(stereoMerger, 0, 0);

      // Right channel processing
      const delayR = offlineContext.createDelay(0.1);
      delayR.delayTime.value = timeR - minTime;
      const absorbR = offlineContext.createBiquadFilter();
      absorbR.type = 'highshelf';
      absorbR.frequency.value = 2000;
      absorbR.gain.value = -this.calculateAirAbsorptionDb(distR);
      mixerR.connect(delayR);
      delayR.connect(absorbR);
      absorbR.connect(stereoMerger, 0, 1);

      // Ground reflection
      if (this.groundReflectionEnabled) {
        const groundDistL = this.calculateGroundReflectionDistance(
          sourcePos, this.micL, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );
        const groundDistR = this.calculateGroundReflectionDistance(
          sourcePos, this.micR, STAGE_CONFIG.sourceHeight, STAGE_CONFIG.micHeight
        );

        const groundGainL = offlineContext.createGain();
        groundGainL.gain.value = Math.min(1.0, refDist / groundDistL) * STAGE_CONFIG.groundReflectionCoeff * track.gain;
        const groundDelayL = offlineContext.createDelay(0.1);
        groundDelayL.delayTime.value = Math.max(0, (groundDistL / SPEED_OF_SOUND) - timeL);
        const groundFilterL = offlineContext.createBiquadFilter();
        groundFilterL.type = 'lowpass';
        groundFilterL.frequency.value = 8000;
        mixerL.connect(groundGainL);
        groundGainL.connect(groundDelayL);
        groundDelayL.connect(groundFilterL);
        groundFilterL.connect(stereoMerger, 0, 0);

        const groundGainR = offlineContext.createGain();
        groundGainR.gain.value = Math.min(1.0, refDist / groundDistR) * STAGE_CONFIG.groundReflectionCoeff * track.gain;
        const groundDelayR = offlineContext.createDelay(0.1);
        groundDelayR.delayTime.value = Math.max(0, (groundDistR / SPEED_OF_SOUND) - timeR);
        const groundFilterR = offlineContext.createBiquadFilter();
        groundFilterR.type = 'lowpass';
        groundFilterR.frequency.value = 8000;
        mixerR.connect(groundGainR);
        groundGainR.connect(groundDelayR);
        groundDelayR.connect(groundFilterR);
        groundFilterR.connect(stereoMerger, 0, 1);
      }

      // Reverb send (stereo - send L and R separately through stereo merger)
      if (reverbConvolver) {
        const reverbSendL = offlineContext.createGain();
        const reverbSendR = offlineContext.createGain();
        const reverbLevel = this.calculateReverbSend(track.y);
        reverbSendL.gain.value = reverbLevel;
        reverbSendR.gain.value = reverbLevel;
        mixerL.connect(reverbSendL);
        mixerR.connect(reverbSendR);
        // Create stereo merger for reverb input
        const reverbMerger = offlineContext.createChannelMerger(2);
        reverbSendL.connect(reverbMerger, 0, 0);
        reverbSendR.connect(reverbMerger, 0, 1);
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
