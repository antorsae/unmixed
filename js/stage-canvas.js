// Semi-circular stage canvas with draggable instrument nodes
// Features: gain-based sizing, edge-drag resize, M/S icons, auto-prefix stripping

import { FAMILY_COLORS } from './positions.js';

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
    this.hoveredZone = null; // 'center', 'edge', 'mute', 'solo', 'mic-left', 'mic-right'

    // Microphone state
    this.micSeparation = 2.0; // meters (0.5 to 6)
    this.isDraggingMic = false;
    this.draggingMicSide = null; // 'left' or 'right'
    this.micDragStartX = 0;
    this.micDragStartSeparation = 2.0;

    // Callbacks
    this.onTrackMove = null;
    this.onTrackSelect = null;
    this.onTrackDeselect = null;
    this.onTrackDoubleClick = null;
    this.onTrackGainChange = null;
    this.onTrackMuteToggle = null;
    this.onTrackSoloToggle = null;
    this.onMicSeparationChange = null;

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

    this.ctx.scale(dpr, dpr);

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
   * Get microphone positions on canvas
   * Returns { left: {x, y}, right: {x, y} }
   */
  getMicPositions() {
    const centerX = this.width / 2;
    const micY = this.height - this.padding + 20; // Below the stage

    // Convert separation (meters) to pixels
    // Map 0.5-6m to roughly 20-200px spread from center
    const maxSpread = Math.min(this.width / 2 - this.padding - 30, 200);
    const minSpread = 20;
    const normalizedSep = (this.micSeparation - 0.5) / 5.5; // 0 to 1
    const spread = minSpread + normalizedSep * (maxSpread - minSpread);

    return {
      left: { x: centerX - spread, y: micY },
      right: { x: centerX + spread, y: micY },
    };
  }

  /**
   * Check if a point is over a microphone
   * Returns 'left', 'right', or null
   */
  getMicAt(canvasX, canvasY) {
    const mics = this.getMicPositions();
    const hitRadius = this.micIconSize / 2 + 6;

    const distLeft = Math.sqrt((canvasX - mics.left.x) ** 2 + (canvasY - mics.left.y) ** 2);
    const distRight = Math.sqrt((canvasX - mics.right.x) ** 2 + (canvasY - mics.right.y) ** 2);

    if (distLeft <= hitRadius) return 'left';
    if (distRight <= hitRadius) return 'right';
    return null;
  }

  /**
   * Set microphone separation (called from external controls)
   */
  setMicSeparation(separation) {
    this.micSeparation = Math.max(0.5, Math.min(6, separation));
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
      this.micDragStartSeparation = this.micSeparation;
      this.canvas.style.cursor = 'ew-resize';
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
      const centerX = this.width / 2;

      // Calculate new separation based on drag
      // Moving left mic left or right mic right increases separation
      const direction = this.draggingMicSide === 'left' ? -1 : 1;
      const pixelsPerMeter = 30; // Sensitivity
      const separationDelta = (deltaX * direction) / pixelsPerMeter;
      const newSeparation = Math.max(0.5, Math.min(6, this.micDragStartSeparation + separationDelta));

      if (newSeparation !== this.micSeparation) {
        this.micSeparation = newSeparation;
        if (this.onMicSeparationChange) {
          this.onMicSeparationChange(newSeparation);
        }
        this.render();
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
      const newPos = this.canvasToTrack(newCanvasX, newCanvasY);

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
          this.canvas.style.cursor = 'ew-resize';
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
   * Draw the L and R microphones
   */
  drawMicrophones() {
    const ctx = this.ctx;
    const mics = this.getMicPositions();
    const size = this.micIconSize;
    const isLeftHovered = this.hoveredZone === 'mic-left' || this.draggingMicSide === 'left';
    const isRightHovered = this.hoveredZone === 'mic-right' || this.draggingMicSide === 'right';

    // Draw connecting line between mics
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(mics.left.x, mics.left.y);
    ctx.lineTo(mics.right.x, mics.right.y);
    ctx.strokeStyle = '#dfd0bf';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw center marker
    const centerX = this.width / 2;
    ctx.beginPath();
    ctx.arc(centerX, mics.left.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#dfd0bf';
    ctx.fill();
    ctx.restore();

    // Draw separation label
    ctx.save();
    ctx.font = '11px "SF Mono", Monaco, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#5a5247';
    ctx.fillText(`${this.micSeparation.toFixed(1)}m`, centerX, mics.left.y + 12);
    ctx.restore();

    // Draw left microphone
    this.drawMicIcon(mics.left.x, mics.left.y, 'L', isLeftHovered);

    // Draw right microphone
    this.drawMicIcon(mics.right.x, mics.right.y, 'R', isRightHovered);
  }

  /**
   * Draw a single microphone icon
   */
  drawMicIcon(x, y, label, isHovered) {
    const ctx = this.ctx;
    const size = this.micIconSize;

    ctx.save();

    // Shadow
    if (isHovered) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
    }

    // Microphone body (capsule shape)
    ctx.beginPath();
    ctx.arc(x, y - size * 0.15, size * 0.4, Math.PI, 0, false);
    ctx.lineTo(x + size * 0.4, y + size * 0.2);
    ctx.arc(x, y + size * 0.2, size * 0.4, 0, Math.PI, false);
    ctx.closePath();

    // Fill with gradient
    const gradient = ctx.createLinearGradient(x - size * 0.4, y, x + size * 0.4, y);
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
      const lineY = y - size * 0.1 + i * 4;
      ctx.beginPath();
      ctx.moveTo(x - size * 0.25, lineY);
      ctx.lineTo(x + size * 0.25, lineY);
      ctx.stroke();
    }

    // Stand
    ctx.beginPath();
    ctx.moveTo(x, y + size * 0.2);
    ctx.lineTo(x, y + size * 0.5);
    ctx.strokeStyle = isHovered ? '#8c3f21' : '#888888';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Base
    ctx.beginPath();
    ctx.moveTo(x - size * 0.3, y + size * 0.5);
    ctx.lineTo(x + size * 0.3, y + size * 0.5);
    ctx.stroke();

    // Label
    ctx.font = `bold ${size * 0.5}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isHovered ? '#b85c38' : '#5a5247';
    ctx.fillText(label, x, y - size * 0.7);

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
