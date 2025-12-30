// Semi-circular stage canvas with draggable instrument nodes
// Features: gain-based sizing, edge-drag resize, M/S icons, auto-prefix stripping
// Microphone visualization: polar patterns, stereo techniques

import { FAMILY_COLORS } from './positions.js';
import {
  STEREO_TECHNIQUES,
  POLAR_PATTERNS,
  applyTechniqueLayout,
  createMicrophoneConfig,
} from './microphone-types.js';
import { getPolarPatternPoints } from './microphone-math.js';

export class StageCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.tracks = new Map(); // trackId -> { x, y, name, family, gain, muted, solo }
    this.selectedIds = new Set();
    this.commonPrefix = ''; // Auto-detected common prefix to strip

    this.isDragging = false;
    this.isResizing = false; // Edge drag = resize (gain)
    this.dragTrackId = null;
    this.dragOffset = { x: 0, y: 0 };
    this.resizeStartGain = 1;
    this.resizeStartY = 0;

    this.hoveredTrackId = null;
    this.hoveredZone = null; // 'center', 'edge', 'mute', 'solo', 'mic-left', 'mic-right', 'mic-center'

    // Microphone state - full configuration for polar patterns and techniques
    this.micConfig = createMicrophoneConfig('spaced-pair');
    this.micSeparation = 2.0; // Legacy (derived from micConfig.spacing)
    this.isDraggingMic = false;
    this.draggingMicSide = null; // 'left', 'right', or 'center'
    this.micDragStartX = 0;
    this.micDragStartY = 0;
    this.micDragStartSeparation = 2.0;
    this.micDragStartCenterDepth = 1.5;

    // Polar pattern visualization settings
    this.showPolarPatterns = true;
    this.polarPatternScale = 25; // Size of polar pattern visualization in pixels

    // Callbacks
    this.onTrackMove = null;
    this.onTrackSelect = null;
    this.onTrackDeselect = null;
    this.onTrackDoubleClick = null;
    this.onTrackGainChange = null;
    this.onTrackMuteToggle = null;
    this.onTrackSoloToggle = null;
    this.onMicSeparationChange = null;
    this.onMicConfigChange = null; // Called when any mic config parameter changes

    // Constants
    this.baseRadius = 18;
    this.minRadius = 12;
    this.maxRadius = 35;
    this.padding = 40;
    this.iconSize = 16;
    this.micIconSize = 24;

    // Setup
    this.setupEventListeners();
    this.resize();

    // Handle window resize
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Resize canvas to match container
   */
  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;

    // Reset transform before scaling to prevent accumulation on repeated resizes
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.width = rect.width;
    this.height = rect.height;

    this.render();
  }

  /**
   * Calculate node radius based on gain
   */
  getNodeRadius(gain) {
    // gain 0 -> minRadius, gain 1 -> baseRadius, gain 2 -> maxRadius
    const t = Math.max(0, Math.min(2, gain)) / 2;
    return this.minRadius + t * (this.maxRadius - this.minRadius);
  }

  /**
   * Convert track coordinates to canvas coordinates
   */
  trackToCanvas(x, y) {
    const stageWidth = this.width - this.padding * 2;
    const stageHeight = this.height - this.padding * 2 - 30;

    const canvasX = this.padding + ((x + 1) / 2) * stageWidth;
    const canvasY = this.padding + 30 + (1 - y) * stageHeight;

    return { x: canvasX, y: canvasY };
  }

  /**
   * Convert canvas coordinates to track coordinates
   */
  canvasToTrack(canvasX, canvasY) {
    const stageWidth = this.width - this.padding * 2;
    const stageHeight = this.height - this.padding * 2 - 30;

    let x = ((canvasX - this.padding) / stageWidth) * 2 - 1;
    let y = 1 - (canvasY - this.padding - 30) / stageHeight;

    x = Math.max(-1, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));

    return { x, y };
  }

  /**
   * Constrain track position to maintain minimum distance from all mics
   * @param {Object} pos - {x, y} normalized position
   * @param {number} minDist - minimum distance in meters (default 0.5m)
   * @returns {Object} - constrained {x, y} position
   */
  constrainMinDistanceFromMics(pos, minDist = 0.5) {
    if (!this.micConfig) return pos;

    // Stage dimensions (must match STAGE_CONFIG in audio-engine.js)
    const stageWidth = 20;  // -10m to +10m
    const stageDepth = 15;  // 0 to 15m
    const sourceHeight = 1.2;
    const micHeight = 1.5;
    const heightDiff = Math.abs(micHeight - sourceHeight);

    // Convert normalized position to meters
    let sourceX = pos.x * (stageWidth / 2);
    let sourceY = pos.y * stageDepth;

    const layoutConfig = applyTechniqueLayout({ ...this.micConfig });
    const micBaseY = this.micConfig.micY || -1;

    // Check distance to each mic and push away if too close
    for (const mic of layoutConfig.mics) {
      if (!mic.enabled) continue;

      const micX = mic.offsetX || 0;
      const micY = micBaseY + (mic.offsetY || 0);

      // 3D distance (including height difference)
      const dx = sourceX - micX;
      const dy = sourceY - micY;
      const dist2D = Math.sqrt(dx * dx + dy * dy);
      const dist3D = Math.sqrt(dist2D * dist2D + heightDiff * heightDiff);

      if (dist3D < minDist && dist2D > 0.001) {
        // Push source away from mic along the 2D direction
        // We need to increase dist2D such that dist3D >= minDist
        // dist3D = sqrt(dist2D^2 + heightDiff^2) >= minDist
        // dist2D >= sqrt(minDist^2 - heightDiff^2)
        const minDist2D = Math.sqrt(Math.max(0, minDist * minDist - heightDiff * heightDiff));
        const scale = minDist2D / dist2D;
        sourceX = micX + dx * scale;
        sourceY = micY + dy * scale;
      }
    }

    // Convert back to normalized and clamp to stage bounds
    return {
      x: Math.max(-1, Math.min(1, sourceX / (stageWidth / 2))),
      y: Math.max(0, Math.min(1, sourceY / stageDepth)),
    };
  }

  /**
   * Get microphone positions on canvas
   * Returns object with positions for all mics in current config
   * { L: {x, y, angle, pattern}, R: {x, y, angle, pattern}, C?: {...} }
   */
  getMicPositions() {
    const centerX = this.width / 2;
    const micY = this.height - this.padding + 20; // Below the stage

    // Convert separation (meters) to pixels
    // Map 0.5-6m to roughly 20-200px spread from center
    const maxSpread = Math.min(this.width / 2 - this.padding - 30, 200);
    const minSpread = 20;

    // Apply technique layout to get current mic positions
    const layoutConfig = applyTechniqueLayout({ ...this.micConfig });
    const technique = STEREO_TECHNIQUES[this.micConfig.technique];

    const result = {};

    for (const mic of layoutConfig.mics) {
      if (!mic.enabled) continue;

      // Calculate pixel position based on mic offset
      // For spacing-based techniques, use offsetX (in meters)
      // Convert meters to pixels using same scale as separation slider
      const normalizedOffset = mic.offsetX / 3; // Normalize to -1 to 1 range (assuming max 3m offset)
      const pixelOffsetX = normalizedOffset * maxSpread;

      // For center depth (Decca Tree), convert Y offset
      const pixelOffsetY = mic.offsetY ? -mic.offsetY * 15 : 0; // Negative because canvas Y is inverted

      result[mic.id] = {
        x: centerX + pixelOffsetX,
        y: micY + pixelOffsetY,
        angle: mic.angle || 0,
        pattern: mic.pattern,
        label: mic.label,
      };
    }

    // Legacy compatibility
    if (result.L && result.R) {
      result.left = result.L;
      result.right = result.R;
    }

    return result;
  }

  /**
   * Set the full microphone configuration
   * @param {Object} config - Full MicrophoneConfig object
   */
  setMicConfig(config) {
    this.micConfig = config;
    this.micSeparation = config.spacing || 2.0;
    this.render();
  }

  /**
   * Update technique and re-render
   * @param {string} techniqueId - Technique ID from STEREO_TECHNIQUES
   */
  setTechnique(techniqueId) {
    this.micConfig = createMicrophoneConfig(techniqueId);
    this.micSeparation = this.micConfig.spacing;
    this.render();
  }

  /**
   * Toggle polar pattern visibility
   * @param {boolean} show - Whether to show polar patterns
   */
  setShowPolarPatterns(show) {
    this.showPolarPatterns = show;
    this.render();
  }

  /**
   * Check if a point is over a microphone
   * Returns 'left', 'right', 'center', or null
   */
  getMicAt(canvasX, canvasY) {
    const mics = this.getMicPositions();
    const hitRadius = this.micIconSize / 2 + 6;

    // Check all mics in config
    for (const [micId, mic] of Object.entries(mics)) {
      // Skip legacy aliases
      if (micId === 'left' || micId === 'right') continue;

      const dist = Math.sqrt((canvasX - mic.x) ** 2 + (canvasY - mic.y) ** 2);
      if (dist <= hitRadius) {
        // Return semantic name for dragging
        if (micId === 'L') return 'left';
        if (micId === 'R') return 'right';
        if (micId === 'C') return 'center';
        return micId.toLowerCase();
      }
    }
    return null;
  }

  /**
   * Get spacing limits for current technique
   * @returns {{min: number, max: number}} Spacing limits in meters
   */
  getSpacingLimits() {
    // adjustable is on the technique definition, not micConfig
    const technique = STEREO_TECHNIQUES[this.micConfig?.technique];
    if (technique?.adjustable?.spacing) {
      return technique.adjustable.spacing;
    }
    return { min: 0.5, max: 6 }; // Default fallback for spaced pair
  }

  /**
   * Set microphone separation (called from external controls)
   */
  setMicSeparation(separation) {
    const limits = this.getSpacingLimits();
    this.micSeparation = Math.max(limits.min, Math.min(limits.max, separation));
    // Also update micConfig to keep in sync
    if (this.micConfig) {
      this.micConfig.spacing = this.micSeparation;
      applyTechniqueLayout(this.micConfig);
    }
    this.render();
  }

  /**
   * Set mic angle for angled techniques (XY, ORTF, Blumlein)
   * @param {number} angle - Total angle between mics in degrees
   */
  setMicAngle(angle) {
    if (this.micConfig) {
      this.micConfig.angle = angle;
      applyTechniqueLayout(this.micConfig);
    }
    this.render();
  }

  /**
   * Set center mic depth for Decca Tree
   * @param {number} depth - Center depth in meters
   */
  setCenterDepth(depth) {
    if (this.micConfig) {
      this.micConfig.centerDepth = depth;
      applyTechniqueLayout(this.micConfig);
    }
    this.render();
  }

  /**
   * Set polar pattern for all mics (or specific mic)
   * @param {string} pattern - Pattern ID from POLAR_PATTERNS
   * @param {string} micId - Optional specific mic ID (L, R, C)
   */
  setMicPattern(pattern, micId = null) {
    if (this.micConfig) {
      for (const mic of this.micConfig.mics) {
        if (!micId || mic.id === micId) {
          const technique = STEREO_TECHNIQUES[this.micConfig.technique];
          // Don't override fixed patterns (e.g., Blumlein must be figure-8)
          if (!technique?.fixedPattern) {
            mic.pattern = pattern;
          }
        }
      }
    }
    this.render();
  }

  /**
   * Find track and zone at canvas position
   * Returns { id, zone } where zone is 'center', 'edge', 'mute', 'solo', or null
   */
  findTrackAt(canvasX, canvasY) {
    const trackIds = Array.from(this.tracks.keys()).reverse();

    for (const id of trackIds) {
      const track = this.tracks.get(id);
      const pos = this.trackToCanvas(track.x, track.y);
      const radius = this.getNodeRadius(track.gain);

      const dx = canvasX - pos.x;
      const dy = canvasY - pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Check M/S icon positions (badges at bottom of circle)
      const badgeY = pos.y + radius - 6;
      const muteIconX = pos.x - 10;
      const muteIconY = badgeY;
      const soloIconX = pos.x + 10;
      const soloIconY = badgeY;

      const muteHit = Math.abs(canvasX - muteIconX) < this.iconSize / 2 + 2 &&
                      Math.abs(canvasY - muteIconY) < this.iconSize / 2 + 2;
      const soloHit = Math.abs(canvasX - soloIconX) < this.iconSize / 2 + 2 &&
                      Math.abs(canvasY - soloIconY) < this.iconSize / 2 + 2;

      if (muteHit) return { id, zone: 'mute' };
      if (soloHit) return { id, zone: 'solo' };

      // Check edge (outer 25% of radius)
      const edgeThreshold = radius * 0.75;
      if (dist <= radius && dist >= edgeThreshold) {
        return { id, zone: 'edge' };
      }

      // Check center
      if (dist < edgeThreshold) {
        return { id, zone: 'center' };
      }
    }

    return { id: null, zone: null };
  }

  /**
   * Set up mouse/touch event listeners
   */
  setupEventListeners() {
    this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));
    this.canvas.addEventListener('mouseleave', (e) => this.handleMouseLeave(e));
    this.canvas.addEventListener('dblclick', (e) => this.handleDoubleClick(e));

    this.canvas.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', (e) => this.handleTouchEnd(e));
  }

  /**
   * Get mouse position relative to canvas
   */
  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  /**
   * Handle mouse down
   */
  handleMouseDown(e) {
    const pos = this.getMousePos(e);

    // Check for mic click first
    const micSide = this.getMicAt(pos.x, pos.y);
    if (micSide) {
      this.isDraggingMic = true;
      this.draggingMicSide = micSide;
      this.micDragStartX = pos.x;
      this.micDragStartY = pos.y;
      this.micDragStartSeparation = this.micSeparation;
      this.micDragStartCenterDepth = this.micConfig?.centerDepth || 1.5;
      // Center mic drags vertically, L/R drag horizontally
      this.canvas.style.cursor = micSide === 'center' ? 'ns-resize' : 'ew-resize';
      return;
    }

    const { id: trackId, zone } = this.findTrackAt(pos.x, pos.y);

    if (trackId) {
      const track = this.tracks.get(trackId);

      // Handle M/S icon clicks
      if (zone === 'mute') {
        track.muted = !track.muted;
        if (this.onTrackMuteToggle) {
          this.onTrackMuteToggle(trackId, track.muted);
        }
        this.render();
        return;
      }

      if (zone === 'solo') {
        track.solo = !track.solo;
        if (this.onTrackSoloToggle) {
          this.onTrackSoloToggle(trackId, track.solo);
        }
        this.render();
        return;
      }

      const trackPos = this.trackToCanvas(track.x, track.y);

      if (zone === 'edge') {
        // Start resize (gain) mode
        this.isResizing = true;
        this.dragTrackId = trackId;
        this.resizeStartGain = track.gain;
        this.resizeStartY = pos.y;
        this.canvas.style.cursor = 'ns-resize';
      } else {
        // Start drag mode
        this.isDragging = true;
        this.dragTrackId = trackId;
        this.dragOffset = {
          x: pos.x - trackPos.x,
          y: pos.y - trackPos.y,
        };
        this.canvas.style.cursor = 'grabbing';
      }

      // Handle selection
      if (!e.shiftKey) {
        this.selectedIds.clear();
      }
      this.selectedIds.add(trackId);
      if (this.onTrackSelect) {
        this.onTrackSelect(trackId, e.shiftKey);
      }

      this.bringToFront(trackId);
      this.render();
    } else {
      // Clicked on empty space
      if (!e.shiftKey) {
        this.selectedIds.clear();
        if (this.onTrackDeselect) {
          this.onTrackDeselect(null);
        }
        this.render();
      }
    }
  }

  /**
   * Handle mouse move
   */
  handleMouseMove(e) {
    const pos = this.getMousePos(e);

    // Handle mic dragging
    if (this.isDraggingMic) {
      const deltaX = pos.x - this.micDragStartX;
      const deltaY = pos.y - this.micDragStartY;
      const pixelsPerMeter = 30; // Sensitivity

      if (this.draggingMicSide === 'center') {
        // Center mic: vertical drag changes depth (Decca Tree)
        const depthDelta = -deltaY / pixelsPerMeter; // Up = more depth
        const technique = STEREO_TECHNIQUES[this.micConfig?.technique];
        if (technique?.adjustable?.centerDepth) {
          const { min, max } = technique.adjustable.centerDepth;
          const newDepth = Math.max(min, Math.min(max, this.micDragStartCenterDepth + depthDelta));
          if (this.micConfig) {
            this.micConfig.centerDepth = newDepth;
            applyTechniqueLayout(this.micConfig);
          }
          if (this.onMicConfigChange) {
            this.onMicConfigChange(this.micConfig);
          }
          this.render();
        }
      } else {
        // L/R mic: horizontal drag changes separation
        const direction = this.draggingMicSide === 'left' ? -1 : 1;
        const separationDelta = (deltaX * direction) / pixelsPerMeter;
        const limits = this.getSpacingLimits();
        const newSeparation = Math.max(limits.min, Math.min(limits.max, this.micDragStartSeparation + separationDelta));

        if (newSeparation !== this.micSeparation) {
          this.micSeparation = newSeparation;
          // Sync with micConfig
          if (this.micConfig) {
            this.micConfig.spacing = newSeparation;
            applyTechniqueLayout(this.micConfig);
          }
          if (this.onMicSeparationChange) {
            this.onMicSeparationChange(newSeparation);
          }
          if (this.onMicConfigChange) {
            this.onMicConfigChange(this.micConfig);
          }
          this.render();
        }
      }
      return;
    }

    if (this.isResizing && this.dragTrackId) {
      // Resize mode: vertical drag changes gain
      const track = this.tracks.get(this.dragTrackId);
      const deltaY = this.resizeStartY - pos.y; // Up = increase
      const gainDelta = deltaY / 100; // 100px = 1 gain
      const newGain = Math.max(0, Math.min(2, this.resizeStartGain + gainDelta));

      track.gain = newGain;
      if (this.onTrackGainChange) {
        this.onTrackGainChange(this.dragTrackId, newGain);
      }
      this.render();
    } else if (this.isDragging && this.dragTrackId) {
      // Drag mode: move track
      const newCanvasX = pos.x - this.dragOffset.x;
      const newCanvasY = pos.y - this.dragOffset.y;
      let newPos = this.canvasToTrack(newCanvasX, newCanvasY);

      // Enforce minimum distance from mics (0.5m)
      newPos = this.constrainMinDistanceFromMics(newPos, 0.5);

      const track = this.tracks.get(this.dragTrackId);
      track.x = newPos.x;
      track.y = newPos.y;

      if (this.onTrackMove) {
        this.onTrackMove(this.dragTrackId, newPos.x, newPos.y);
      }
      this.render();
    } else {
      // Check mic hover first
      const micSide = this.getMicAt(pos.x, pos.y);
      if (micSide) {
        if (this.hoveredZone !== 'mic-' + micSide) {
          this.hoveredTrackId = null;
          this.hoveredZone = 'mic-' + micSide;
          // Center mic drags vertically, L/R drag horizontally
          this.canvas.style.cursor = micSide === 'center' ? 'ns-resize' : 'ew-resize';
          this.render();
        }
        return;
      }

      // Update hover state
      const { id: trackId, zone } = this.findTrackAt(pos.x, pos.y);

      if (trackId !== this.hoveredTrackId || zone !== this.hoveredZone) {
        this.hoveredTrackId = trackId;
        this.hoveredZone = zone;

        if (!trackId) {
          this.canvas.style.cursor = 'default';
        } else if (zone === 'edge') {
          this.canvas.style.cursor = 'ns-resize';
        } else if (zone === 'mute' || zone === 'solo') {
          this.canvas.style.cursor = 'pointer';
        } else {
          this.canvas.style.cursor = 'grab';
        }

        this.render();
      }
    }
  }

  /**
   * Handle mouse up
   */
  handleMouseUp(e) {
    this.isDragging = false;
    this.isResizing = false;
    this.isDraggingMic = false;
    this.draggingMicSide = null;
    this.dragTrackId = null;
    this.canvas.style.cursor = 'default';
  }

  /**
   * Handle mouse leave
   */
  handleMouseLeave(e) {
    this.hoveredTrackId = null;
    this.hoveredZone = null;

    if (!this.isDragging && !this.isResizing) {
      this.canvas.style.cursor = 'default';
      this.render();
    }
  }

  /**
   * Handle double click
   */
  handleDoubleClick(e) {
    const pos = this.getMousePos(e);
    const { id: trackId } = this.findTrackAt(pos.x, pos.y);

    if (trackId && this.onTrackDoubleClick) {
      this.onTrackDoubleClick(trackId);
    }
  }

  /**
   * Handle touch start
   */
  handleTouchStart(e) {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = this.canvas.getBoundingClientRect();
      const pos = {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };

      const { id: trackId, zone } = this.findTrackAt(pos.x, pos.y);

      if (trackId && zone === 'center') {
        e.preventDefault();

        const track = this.tracks.get(trackId);
        const trackPos = this.trackToCanvas(track.x, track.y);

        this.isDragging = true;
        this.dragTrackId = trackId;
        this.dragOffset = {
          x: pos.x - trackPos.x,
          y: pos.y - trackPos.y,
        };

        this.selectedIds.clear();
        this.selectedIds.add(trackId);

        if (this.onTrackSelect) {
          this.onTrackSelect(trackId, false);
        }

        this.bringToFront(trackId);
        this.render();
      }
    }
  }

  /**
   * Handle touch move
   */
  handleTouchMove(e) {
    if (this.isDragging && e.touches.length === 1) {
      e.preventDefault();

      const touch = e.touches[0];
      const rect = this.canvas.getBoundingClientRect();
      const pos = {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };

      const newCanvasX = pos.x - this.dragOffset.x;
      const newCanvasY = pos.y - this.dragOffset.y;
      const newPos = this.canvasToTrack(newCanvasX, newCanvasY);

      const track = this.tracks.get(this.dragTrackId);
      track.x = newPos.x;
      track.y = newPos.y;

      if (this.onTrackMove) {
        this.onTrackMove(this.dragTrackId, newPos.x, newPos.y);
      }

      this.render();
    }
  }

  /**
   * Handle touch end
   */
  handleTouchEnd(e) {
    this.isDragging = false;
    this.isResizing = false;
    this.dragTrackId = null;
  }

  /**
   * Bring a track to the front
   */
  bringToFront(trackId) {
    const track = this.tracks.get(trackId);
    if (track) {
      this.tracks.delete(trackId);
      this.tracks.set(trackId, track);
    }
  }

  /**
   * Detect and strip common prefix from all track names
   */
  updateCommonPrefix() {
    const names = Array.from(this.tracks.values()).map(t => t.name);

    if (names.length < 2) {
      this.commonPrefix = '';
      return;
    }

    // Find common prefix character by character
    let prefix = '';
    const firstWord = names[0];

    for (let i = 0; i < firstWord.length; i++) {
      const char = firstWord[i];
      const allMatch = names.every(name => name.length > i && name[i] === char);

      if (allMatch) {
        prefix += char;
      } else {
        break;
      }
    }

    // Only strip if prefix ends with space/dash/underscore and is substantial
    if (prefix.length >= 3 && /[\s\-_]$/.test(prefix)) {
      this.commonPrefix = prefix;
    } else if (prefix.length >= 3) {
      // Try to find last space/dash/underscore within prefix
      const lastSep = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('-'), prefix.lastIndexOf('_'));
      if (lastSep >= 2) {
        this.commonPrefix = prefix.substring(0, lastSep + 1);
      } else {
        this.commonPrefix = '';
      }
    } else {
      this.commonPrefix = '';
    }

    console.log('[StageCanvas] Common prefix:', JSON.stringify(this.commonPrefix), 'from', names.length, 'tracks');
  }

  /**
   * Get display name (with prefix stripped)
   */
  getDisplayName(track) {
    if (this.commonPrefix && track.name.startsWith(this.commonPrefix)) {
      return track.name.slice(this.commonPrefix.length);
    }
    return track.name;
  }

  /**
   * Add a track to the canvas
   */
  addTrack(id, data) {
    this.tracks.set(id, {
      x: data.x,
      y: data.y,
      name: data.name,
      family: data.family,
      gain: data.gain ?? 1,
      muted: data.muted ?? false,
      solo: data.solo ?? false,
    });
    // Don't update prefix on every add - call refreshCommonPrefix() after batch add
    this.render();
  }

  /**
   * Refresh common prefix (call after batch adding tracks)
   */
  refreshCommonPrefix() {
    this.updateCommonPrefix();
    this.render();
  }

  /**
   * Update track position
   */
  updateTrackPosition(id, x, y) {
    const track = this.tracks.get(id);
    if (track) {
      track.x = x;
      track.y = y;
      this.render();
    }
  }

  /**
   * Update track gain
   */
  updateTrackGain(id, gain) {
    const track = this.tracks.get(id);
    if (track) {
      track.gain = gain;
      this.render();
    }
  }

  /**
   * Update track muted state
   */
  updateTrackMuted(id, muted) {
    const track = this.tracks.get(id);
    if (track) {
      track.muted = muted;
      this.render();
    }
  }

  /**
   * Update track solo state
   */
  updateTrackSolo(id, solo) {
    const track = this.tracks.get(id);
    if (track) {
      track.solo = solo;
      this.render();
    }
  }

  /**
   * Remove a track
   */
  removeTrack(id) {
    this.tracks.delete(id);
    this.selectedIds.delete(id);
    this.updateCommonPrefix();
    this.render();
  }

  /**
   * Clear all tracks
   */
  clearTracks() {
    this.tracks.clear();
    this.selectedIds.clear();
    this.commonPrefix = '';
    this.render();
  }

  /**
   * Select a track
   */
  selectTrack(id) {
    this.selectedIds.clear();
    this.selectedIds.add(id);
    this.render();
  }

  /**
   * Deselect all tracks
   */
  deselectAll() {
    this.selectedIds.clear();
    this.render();
  }

  /**
   * Render the canvas
   */
  render() {
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;

    // Reset transform completely and reapply DPR scale (Firefox fix)
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Reset all context state explicitly (Firefox compatibility)
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = '#000000';
    ctx.strokeStyle = '#000000';

    this.drawStage();
    this.drawGrid();
    this.drawMicrophones();

    for (const [id, track] of this.tracks) {
      this.drawTrackNode(id, track);
    }
  }

  /**
   * Draw all microphones based on current technique configuration
   */
  drawMicrophones() {
    const ctx = this.ctx;
    const mics = this.getMicPositions();
    const technique = STEREO_TECHNIQUES[this.micConfig.technique];
    const centerX = this.width / 2;

    // Get mic positions for L and R (and C if present)
    const micL = mics.L;
    const micR = mics.R;
    const micC = mics.C;

    // Determine hover states
    const isLeftHovered = this.hoveredZone === 'mic-left' || this.draggingMicSide === 'left';
    const isRightHovered = this.hoveredZone === 'mic-right' || this.draggingMicSide === 'right';
    const isCenterHovered = this.hoveredZone === 'mic-center' || this.draggingMicSide === 'center';

    ctx.save();

    // Draw connecting lines between mics
    ctx.beginPath();
    if (micL && micR) {
      ctx.moveTo(micL.x, micL.y);
      if (micC && technique?.hasCenter) {
        // Decca Tree: L -> C -> R triangle
        ctx.lineTo(micC.x, micC.y);
        ctx.lineTo(micR.x, micR.y);
      } else {
        // Standard: L -> R line
        ctx.lineTo(micR.x, micR.y);
      }
    }
    ctx.strokeStyle = '#dfd0bf';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw center reference point (for non-Decca techniques)
    if (!micC || !technique?.hasCenter) {
      ctx.beginPath();
      ctx.arc(centerX, micL?.y || (this.height - this.padding + 20), 3, 0, Math.PI * 2);
      ctx.fillStyle = '#dfd0bf';
      ctx.fill();
    }
    ctx.restore();

    // Draw technique label and spacing info
    ctx.save();
    ctx.font = '11px "SF Mono", Monaco, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#5a5247';

    const techniqueName = technique?.name || 'Spaced Pair';
    const labelY = (micL?.y || (this.height - this.padding + 20)) + this.micIconSize + 8;
    ctx.fillText(techniqueName, centerX, labelY);

    // Show spacing for applicable techniques
    if (technique?.adjustable?.spacing && this.micConfig.spacing) {
      ctx.fillText(`${this.micConfig.spacing.toFixed(2)}m`, centerX, labelY + 14);
    }
    // Show angle for applicable techniques
    if (technique?.adjustable?.angle && this.micConfig.angle) {
      const angleText = technique?.adjustable?.spacing
        ? `${this.micConfig.angle}°`
        : `${this.micConfig.angle}°`;
      ctx.fillText(angleText, centerX, labelY + (technique?.adjustable?.spacing ? 28 : 14));
    }
    ctx.restore();

    // Draw polar patterns first (behind mic icons)
    if (this.showPolarPatterns) {
      if (micL) this.drawPolarPattern(micL.x, micL.y, micL.pattern, micL.angle);
      if (micR) this.drawPolarPattern(micR.x, micR.y, micR.pattern, micR.angle);
      if (micC && technique?.hasCenter) {
        this.drawPolarPattern(micC.x, micC.y, micC.pattern, micC.angle);
      }
    }

    // Draw microphone icons
    if (micL) this.drawMicIcon(micL.x, micL.y, 'L', isLeftHovered, micL.angle);
    if (micR) this.drawMicIcon(micR.x, micR.y, 'R', isRightHovered, micR.angle);
    if (micC && technique?.hasCenter) {
      this.drawMicIcon(micC.x, micC.y, 'C', isCenterHovered, micC.angle);
    }
  }

  /**
   * Draw polar pattern visualization around a microphone
   * @param {number} x - Center X position
   * @param {number} y - Center Y position
   * @param {string} patternType - Polar pattern type ID
   * @param {number} angle - Mic angle in degrees (0 = facing up/toward stage)
   */
  drawPolarPattern(x, y, patternType, angle = 0) {
    const ctx = this.ctx;
    const pattern = POLAR_PATTERNS[patternType];
    if (!pattern) return;

    const points = getPolarPatternPoints(patternType, 72);
    const scale = this.polarPatternScale;

    ctx.save();

    // Translate to mic position and rotate for mic angle
    ctx.translate(x, y);
    // Mic angle: 0 = facing +Y (up in canvas terms, toward stage)
    // Rotate so 0° points up
    ctx.rotate((angle * Math.PI) / 180);

    // Draw the polar pattern shape
    ctx.beginPath();

    // Style based on pattern type
    ctx.strokeStyle = pattern.color || '#666666';
    ctx.lineWidth = 1.5;
    ctx.fillStyle = pattern.color || '#666666';

    let inNegative = null;
    const strokeAlpha = 0.6;
    const fillAlpha = 0.1;

    const strokeAndFill = () => {
      ctx.globalAlpha = strokeAlpha;
      ctx.stroke();
      ctx.globalAlpha = fillAlpha;
      ctx.fill();
    };

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const px = pt.x * scale;
      const py = pt.y * scale;  // Already in canvas coordinates

      if (i === 0) {
        ctx.moveTo(px, py);
        inNegative = pt.isNegative;
      } else {
        // If we're transitioning between positive and negative lobes, draw separately
        if (pt.isNegative !== inNegative) {
          strokeAndFill();
          ctx.beginPath();
          ctx.moveTo(px, py);
          inNegative = pt.isNegative;
        }
        ctx.lineTo(px, py);
      }
    }

    strokeAndFill();

    // Draw mic axis indicator (direction mic is pointing)
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -scale * 0.7); // Arrow pointing in mic direction
    ctx.strokeStyle = pattern.color || '#666666';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Arrow head
    ctx.beginPath();
    ctx.moveTo(-4, -scale * 0.5);
    ctx.lineTo(0, -scale * 0.7);
    ctx.lineTo(4, -scale * 0.5);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw a single microphone icon
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {string} label - Mic label (L, R, C)
   * @param {boolean} isHovered - Whether mic is hovered
   * @param {number} angle - Mic angle in degrees (0 = facing up)
   */
  drawMicIcon(x, y, label, isHovered, angle = 0) {
    const ctx = this.ctx;
    const size = this.micIconSize;

    ctx.save();

    // Shadow
    if (isHovered) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
    }

    // Translate to position and rotate for mic angle
    ctx.translate(x, y);
    ctx.rotate((angle * Math.PI) / 180);

    // Microphone body (capsule shape) - drawn relative to origin now
    ctx.beginPath();
    ctx.arc(0, -size * 0.15, size * 0.4, Math.PI, 0, false);
    ctx.lineTo(size * 0.4, size * 0.2);
    ctx.arc(0, size * 0.2, size * 0.4, 0, Math.PI, false);
    ctx.closePath();

    // Fill with gradient
    const gradient = ctx.createLinearGradient(-size * 0.4, 0, size * 0.4, 0);
    gradient.addColorStop(0, isHovered ? '#5a5247' : '#6b6b6b');
    gradient.addColorStop(0.5, isHovered ? '#8c3f21' : '#888888');
    gradient.addColorStop(1, isHovered ? '#5a5247' : '#6b6b6b');
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.shadowColor = 'transparent';

    // Mic grille lines
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      const lineY = -size * 0.1 + i * 4;
      ctx.beginPath();
      ctx.moveTo(-size * 0.25, lineY);
      ctx.lineTo(size * 0.25, lineY);
      ctx.stroke();
    }

    // Stand
    ctx.beginPath();
    ctx.moveTo(0, size * 0.2);
    ctx.lineTo(0, size * 0.5);
    ctx.strokeStyle = isHovered ? '#8c3f21' : '#888888';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Base
    ctx.beginPath();
    ctx.moveTo(-size * 0.3, size * 0.5);
    ctx.lineTo(size * 0.3, size * 0.5);
    ctx.stroke();

    // Reset rotation for label (keep label upright)
    ctx.rotate((-angle * Math.PI) / 180);

    // Label
    ctx.font = `bold ${size * 0.5}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isHovered ? '#b85c38' : '#5a5247';
    ctx.fillText(label, 0, -size * 0.7);

    ctx.restore();
  }

  /**
   * Draw the semi-circular stage
   */
  drawStage() {
    const ctx = this.ctx;
    const centerX = this.width / 2;
    const bottomY = this.height - this.padding;
    const radius = Math.min(this.width - this.padding * 2, (this.height - this.padding * 2 - 30) * 1.5) / 2;

    ctx.save();

    ctx.beginPath();
    ctx.arc(centerX, bottomY, radius, Math.PI, 0, false);
    ctx.lineTo(centerX + radius, bottomY);
    ctx.lineTo(centerX - radius, bottomY);
    ctx.closePath();

    const gradient = ctx.createRadialGradient(centerX, bottomY, 0, centerX, bottomY, radius);
    gradient.addColorStop(0, '#f8f8f8');
    gradient.addColorStop(1, '#eeeeee');
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw subtle grid lines
   */
  drawGrid() {
    const ctx = this.ctx;
    const stageWidth = this.width - this.padding * 2;
    const stageHeight = this.height - this.padding * 2 - 30;

    ctx.save();
    ctx.strokeStyle = '#dddddd';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);

    for (let x = -1; x <= 1; x += 0.25) {
      const canvasX = this.padding + ((x + 1) / 2) * stageWidth;
      ctx.beginPath();
      ctx.moveTo(canvasX, this.padding + 30);
      ctx.lineTo(canvasX, this.height - this.padding);
      ctx.stroke();
    }

    for (let y = 0; y <= 1; y += 0.25) {
      const canvasY = this.padding + 30 + (1 - y) * stageHeight;
      ctx.beginPath();
      ctx.moveTo(this.padding, canvasY);
      ctx.lineTo(this.width - this.padding, canvasY);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Draw a track node
   */
  drawTrackNode(id, track) {
    try {
    const ctx = this.ctx;
    const pos = this.trackToCanvas(track.x, track.y);
    const isSelected = this.selectedIds.has(id);
    const isHovered = this.hoveredTrackId === id;
    const isMuted = track.muted;

    const color = FAMILY_COLORS[track.family] || '#888888';
    const radius = this.getNodeRadius(track.gain);

    ctx.save();

    // Draw shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
    ctx.shadowBlur = isSelected ? 10 : 5;
    ctx.shadowOffsetY = 2;

    // Draw circle
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);

    // Fill (dimmed if muted)
    ctx.fillStyle = isMuted ? this.dimColor(color, 0.4) : color;
    ctx.fill();

    ctx.shadowColor = 'transparent';

    // Edge highlight when hovering edge zone
    if (isHovered && this.hoveredZone === 'edge') {
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 4;
    } else if (isSelected) {
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 3;
    } else if (isHovered) {
      ctx.strokeStyle = '#666666';
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.lineWidth = 1;
    }
    ctx.stroke();

    // Draw label (inside circle)
    ctx.fillStyle = isMuted ? 'rgba(255,255,255,0.6)' : 'white';
    ctx.font = `bold ${Math.max(9, Math.min(12, radius * 0.6))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const displayName = this.getDisplayName(track);
    let label = displayName;
    const maxChars = Math.floor(radius / 4);
    if (label.length > maxChars) {
      label = label.substring(0, maxChars - 1) + '…';
    }
    ctx.fillText(label, pos.x, pos.y);

    ctx.restore();

    // Draw M/S icons (small badges at bottom of circle)
    const badgeY = pos.y + radius - 6;
    this.drawMuteIcon(pos.x - 10, badgeY, track.muted, isHovered && this.hoveredZone === 'mute');
    this.drawSoloIcon(pos.x + 10, badgeY, track.solo, isHovered && this.hoveredZone === 'solo');

    // Draw gain indicator arc around circle
    this.drawGainArc(pos.x, pos.y, radius, track.gain);

    // Draw tooltip if hovered
    if (isHovered && this.hoveredZone !== 'mute' && this.hoveredZone !== 'solo') {
      this.drawTooltip(pos.x, pos.y - radius - 25, track);
    }
    } catch (err) {
      console.error('[StageCanvas] Error drawing track:', id, err);
    }
  }

  /**
   * Draw mute icon
   */
  drawMuteIcon(x, y, isMuted, isHovered) {
    const ctx = this.ctx;
    const size = this.iconSize;
    const r = size / 2 + 2;

    ctx.save();
    ctx.setLineDash([]); // Reset line dash
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // Background circle
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = isMuted ? '#dc2626' : (isHovered ? '#555' : '#888');
    ctx.fill();

    // Letter M
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(size * 0.65)}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', x, y + 1);

    ctx.restore();
  }

  /**
   * Draw solo icon
   */
  drawSoloIcon(x, y, isSolo, isHovered) {
    const ctx = this.ctx;
    const size = this.iconSize;
    const r = size / 2 + 2;

    ctx.save();
    ctx.setLineDash([]);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // Background circle
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = isSolo ? '#ca8a04' : (isHovered ? '#555' : '#888');
    ctx.fill();

    // Letter S
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(size * 0.65)}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('S', x, y + 1);

    ctx.restore();
  }

  /**
   * Draw gain indicator arc
   */
  drawGainArc(x, y, radius, gain) {
    const ctx = this.ctx;
    const arcRadius = radius + 5;
    const startAngle = Math.PI * 0.75;

    ctx.save();
    ctx.setLineDash([]);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // Background arc
    ctx.beginPath();
    ctx.arc(x, y, arcRadius, startAngle, startAngle + Math.PI * 1.5, false);
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Gain arc
    if (gain > 0.01) {
      ctx.beginPath();
      ctx.arc(x, y, arcRadius, startAngle, startAngle + (Math.PI * 1.5) * Math.min(gain, 2) / 2, false);
      ctx.strokeStyle = gain > 1 ? '#dc2626' : '#22c55e';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Dim a color
   */
  dimColor(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const gray = (r + g + b) / 3;
    const nr = Math.round(r + (gray - r) * amount);
    const ng = Math.round(g + (gray - g) * amount);
    const nb = Math.round(b + (gray - b) * amount);
    return `rgb(${nr}, ${ng}, ${nb})`;
  }

  /**
   * Draw a tooltip
   */
  drawTooltip(x, y, track) {
    const ctx = this.ctx;
    const displayName = this.getDisplayName(track);
    const text = `${displayName}\nGain: ${track.gain.toFixed(2)}`;
    const lines = text.split('\n');

    ctx.save();
    ctx.font = '12px sans-serif';

    let maxWidth = 0;
    for (const line of lines) {
      const metrics = ctx.measureText(line);
      maxWidth = Math.max(maxWidth, metrics.width);
    }

    const padding = 8;
    const lineHeight = 16;
    const boxWidth = maxWidth + padding * 2;
    const boxHeight = lines.length * lineHeight + padding * 2;

    let tooltipX = x - boxWidth / 2;
    let tooltipY = y - boxHeight;

    if (tooltipX < 5) tooltipX = 5;
    if (tooltipX + boxWidth > this.width - 5) tooltipX = this.width - boxWidth - 5;
    if (tooltipY < 5) tooltipY = y + 40;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.beginPath();
    // roundRect polyfill for Firefox compatibility
    if (ctx.roundRect) {
      ctx.roundRect(tooltipX, tooltipY, boxWidth, boxHeight, 4);
    } else {
      // Fallback: draw rectangle with rounded corners manually
      const r = 4;
      ctx.moveTo(tooltipX + r, tooltipY);
      ctx.lineTo(tooltipX + boxWidth - r, tooltipY);
      ctx.quadraticCurveTo(tooltipX + boxWidth, tooltipY, tooltipX + boxWidth, tooltipY + r);
      ctx.lineTo(tooltipX + boxWidth, tooltipY + boxHeight - r);
      ctx.quadraticCurveTo(tooltipX + boxWidth, tooltipY + boxHeight, tooltipX + boxWidth - r, tooltipY + boxHeight);
      ctx.lineTo(tooltipX + r, tooltipY + boxHeight);
      ctx.quadraticCurveTo(tooltipX, tooltipY + boxHeight, tooltipX, tooltipY + boxHeight - r);
      ctx.lineTo(tooltipX, tooltipY + r);
      ctx.quadraticCurveTo(tooltipX, tooltipY, tooltipX + r, tooltipY);
      ctx.closePath();
    }
    ctx.fill();

    ctx.fillStyle = 'white';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], tooltipX + padding, tooltipY + padding + i * lineHeight);
    }

    ctx.restore();
  }
}
