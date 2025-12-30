// instrument-icons.js
//
// Emoji-based instrument icons for orchestra
// Features:
//   - Per-instrument emoji icons
//   - Full instrument names
//   - Index subscripts for sectioned instruments (Violin 1a, Horn 3, etc.)
//   - Optimized pattern matching for underscore-delimited track names

/* ---------------------------------------------
 * Instrument definitions with emojis
 * -------------------------------------------- */

export const INSTRUMENTS = {
  // Strings 🎻
  violin:     { name: 'Violin', emoji: '🎻', family: 'strings' },
  viola:      { name: 'Viola', emoji: '🎻', family: 'strings' },
  cello:      { name: 'Cello', emoji: '🎻', family: 'strings' },
  violoncello:{ name: 'Cello', emoji: '🎻', family: 'strings' },
  contrabass: { name: 'Bass', emoji: '🎻', family: 'strings' },
  bass:       { name: 'Bass', emoji: '🎻', family: 'strings' },

  // Brass 🎺 📯
  horn:       { name: 'Horn', emoji: '📯', family: 'brass' },
  trumpet:    { name: 'Trumpet', emoji: '🎺', family: 'brass' },
  trombone:   { name: 'Trombone', emoji: '🎺', family: 'brass' },
  tuba:       { name: 'Tuba', emoji: '📯', family: 'brass' },
  cornet:     { name: 'Cornet', emoji: '🎺', family: 'brass' },

  // Woodwinds 🪈 🎷
  flute:      { name: 'Flute', emoji: '🪈', family: 'woodwinds' },
  piccolo:    { name: 'Piccolo', emoji: '🪈', family: 'woodwinds' },
  oboe:       { name: 'Oboe', emoji: '🎷', family: 'woodwinds' },
  clarinet:   { name: 'Clarinet', emoji: '🎷', family: 'woodwinds' },
  bassoon:    { name: 'Bassoon', emoji: '🎷', family: 'woodwinds' },
  englishhorn:{ name: 'Eng Horn', emoji: '🎷', family: 'woodwinds' },

  // Percussion 🥁 🪘
  timpani:    { name: 'Timpani', emoji: '🥁', family: 'percussion' },
  percussion: { name: 'Perc', emoji: '🪘', family: 'percussion' },
  drums:      { name: 'Drums', emoji: '🥁', family: 'percussion' },
  xylophone:  { name: 'Xylo', emoji: '🎵', family: 'percussion' },
  glockenspiel:{ name: 'Glock', emoji: '🔔', family: 'percussion' },
  vibraphone: { name: 'Vibes', emoji: '🎵', family: 'percussion' },
  cymbal:     { name: 'Cymbal', emoji: '🥁', family: 'percussion' },
  triangle:   { name: 'Triangle', emoji: '🔺', family: 'percussion' },

  // Keyboard 🎹 🪕
  piano:      { name: 'Piano', emoji: '🎹', family: 'keyboard' },
  harp:       { name: 'Harp', emoji: '🪕', family: 'keyboard' },
  celesta:    { name: 'Celesta', emoji: '🎹', family: 'keyboard' },
  organ:      { name: 'Organ', emoji: '🎹', family: 'keyboard' },

  // Voice 👩‍🎤 👨‍🎤
  soprano:    { name: 'Soprano', emoji: '👩‍🎤', family: 'voice', gender: 'f' },
  alto:       { name: 'Alto', emoji: '👩‍🎤', family: 'voice', gender: 'f' },
  mezzo:      { name: 'Mezzo', emoji: '👩‍🎤', family: 'voice', gender: 'f' },
  tenor:      { name: 'Tenor', emoji: '👨‍🎤', family: 'voice', gender: 'm' },
  baritone:   { name: 'Baritone', emoji: '👨‍🎤', family: 'voice', gender: 'm' },
  basssinger: { name: 'Bass', emoji: '👨‍🎤', family: 'voice', gender: 'm' },
};

// Pattern matching optimized for underscore-delimited track names
// e.g., "beethoven_vl1a_6" or "mozart_corno2"
const ABBREV_PATTERNS = [
  // Strings - check viola before violin (vla vs vl)
  { pattern: /_vla[a-c]?(?:_|$)/i, instrument: 'viola' },
  { pattern: /_vl[12][a-h]?(?:_|$)/i, instrument: 'violin' },
  { pattern: /_vc[a-b]?(?:_|$)/i, instrument: 'cello' },
  { pattern: /_kb[a-b]?(?:_|$)/i, instrument: 'contrabass' },
  { pattern: /contrabass|double\s*bass/i, instrument: 'contrabass' },

  // Brass
  { pattern: /_corno\d*(?:_|$)/i, instrument: 'horn' },
  { pattern: /_tr[1-9](?:_|$)/i, instrument: 'trumpet' },
  { pattern: /_trb\d*(?:_|$)/i, instrument: 'trombone' },
  { pattern: /_tuba(?:_|$)/i, instrument: 'tuba' },

  // Woodwinds
  { pattern: /_fl\d*(?:_|$)/i, instrument: 'flute' },
  { pattern: /_picc(?:_|$)/i, instrument: 'piccolo' },
  { pattern: /_ob\d*(?:_|$)/i, instrument: 'oboe' },
  { pattern: /_cl\d*(?:_|$)/i, instrument: 'clarinet' },
  { pattern: /_bsn\d*(?:_|$)/i, instrument: 'bassoon' },
  { pattern: /_eh(?:_|$)|english\s*horn|cor\s*anglais/i, instrument: 'englishhorn' },

  // Percussion
  { pattern: /_timp\d*(?:_|$)/i, instrument: 'timpani' },
  { pattern: /_perc\d*(?:_|$)/i, instrument: 'percussion' },
  { pattern: /xylophone/i, instrument: 'xylophone' },
  { pattern: /glockenspiel|glock/i, instrument: 'glockenspiel' },
  { pattern: /vibraphone|vibes/i, instrument: 'vibraphone' },
  { pattern: /cymbal/i, instrument: 'cymbal' },
  { pattern: /triangle/i, instrument: 'triangle' },
  { pattern: /drum/i, instrument: 'drums' },

  // Keyboard
  { pattern: /piano|klavier/i, instrument: 'piano' },
  { pattern: /harp|harfe/i, instrument: 'harp' },
  { pattern: /celesta/i, instrument: 'celesta' },
  { pattern: /organ/i, instrument: 'organ' },

  // Voice (check bass singer before generic bass)
  { pattern: /soprano|sopr/i, instrument: 'soprano' },
  { pattern: /\balto\b/i, instrument: 'alto' },
  { pattern: /mezzo/i, instrument: 'mezzo' },
  { pattern: /tenor/i, instrument: 'tenor' },
  { pattern: /baritone/i, instrument: 'baritone' },
  { pattern: /\bbass\b.*(?:voice|sing|vocal|solo)/i, instrument: 'basssinger' },
];

/* ---------------------------------------------
 * Detection functions
 * -------------------------------------------- */

/**
 * Detect specific instrument from name
 * @param {string} name - Track/instrument name
 * @returns {Object|null} - Instrument definition or null
 */
export function detectInstrument(name) {
  // Normalize: convert spaces to underscores and prepend _ for boundary matching
  // This handles both "beethoven_fl1" (original) and "Beethoven Fl1" (from track-parser)
  const normalized = '_' + (name || '').toLowerCase().replace(/\s+/g, '_');

  for (const { pattern, instrument } of ABBREV_PATTERNS) {
    if (pattern.test(normalized)) {
      return INSTRUMENTS[instrument];
    }
  }

  return null;
}

/**
 * Parse index from instrument name
 * Handles: vl1a -> "1a", corno7 -> "7", vlaa -> "a", vca -> "a"
 * @param {string} name - Instrument name
 * @returns {string|null} - Index string or null
 */
export function parseIndex(name) {
  // Normalize spaces to underscores for consistent pattern matching
  const raw = String(name || '').replace(/\s+/g, '_');

  // Violin pattern: vl followed by section (1 or 2) and optional desk letter
  const vlMatch = raw.match(/_vl([12])([a-h])?(?:_|$)/i);
  if (vlMatch) {
    return vlMatch[1] + (vlMatch[2] || '');
  }

  // Viola pattern: vla followed by optional desk letter
  const vlaMatch = raw.match(/_vla([a-c])?(?:_|$)/i);
  if (vlaMatch && vlaMatch[1]) {
    return vlaMatch[1];
  }

  // Cello pattern: vc followed by optional desk letter
  const vcMatch = raw.match(/_vc([a-b])?(?:_|$)/i);
  if (vcMatch && vcMatch[1]) {
    return vcMatch[1];
  }

  // Contrabass pattern: kb followed by optional desk letter
  const kbMatch = raw.match(/_kb([a-b])?(?:_|$)/i);
  if (kbMatch && kbMatch[1]) {
    return kbMatch[1];
  }

  // Generic number pattern for wind/brass/percussion
  const numMatch = raw.match(/(\d+)(?:_|$)/);
  if (numMatch) {
    return numMatch[1];
  }

  return null;
}

/**
 * Get icon info for a track
 * @param {string} name - Track name
 * @param {string} family - Detected family (fallback)
 * @returns {Object} - { name, emoji, index, family }
 */
export function getIconInfo(name, family) {
  const instrument = detectInstrument(name);
  const index = parseIndex(name);

  if (instrument) {
    return {
      name: instrument.name,
      emoji: instrument.emoji,
      index,
      family: instrument.family,
      gender: instrument.gender,
    };
  }

  // Fallback to family-based generic icon
  const familyDefaults = {
    strings:    { name: 'Strings', emoji: '🎻' },
    woodwinds:  { name: 'Winds', emoji: '🎵' },
    brass:      { name: 'Brass', emoji: '🎺' },
    percussion: { name: 'Perc', emoji: '🥁' },
    keyboard:   { name: 'Keys', emoji: '🎹' },
    voice:      { name: 'Voice', emoji: '🎤' },
  };

  const fallback = familyDefaults[family] || { name: '?', emoji: '❓' };

  return {
    name: fallback.name,
    emoji: fallback.emoji,
    index,
    family: family || 'unknown',
  };
}

/* ---------------------------------------------
 * Emoji-based icon rendering
 * -------------------------------------------- */

/**
 * Draw instrument icon on canvas using emoji
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {number} x - Center X
 * @param {number} y - Center Y
 * @param {Object} iconInfo - From getIconInfo() { name, emoji, index, family }
 * @param {string} color - Fill color (unused, kept for API compatibility)
 * @param {number} size - Icon size (default 24)
 * @param {Object} options - { isSelected, isHovered, isMuted, isSoloed, isDimmed }
 */
export function drawInstrumentIcon(ctx, x, y, iconInfo, color, size = 24, options = {}) {
  const { isSelected, isHovered, isMuted, isSoloed, isDimmed } = options;

  ctx.save();
  ctx.translate(x, y);

  // Get emoji directly from iconInfo (per-instrument emoji)
  const emoji = iconInfo.emoji || '🎵';

  // Apply visual states
  let alpha = 1.0;
  if (isDimmed) {
    alpha = 0.3;
  } else if (isMuted) {
    alpha = 0.5;
  }
  ctx.globalAlpha = alpha;

  // Apply grayscale filter for muted state
  if (isMuted) {
    ctx.filter = 'grayscale(100%)';
  }

  // Draw selection ring (blue)
  if (isSelected) {
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.6, 0, Math.PI * 2);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Draw solo glow (golden)
  if (isSoloed) {
    ctx.shadowColor = '#fbbf24';
    ctx.shadowBlur = 12;
  }

  // Draw hover effect (slight scale-up handled by size param, add subtle shadow)
  if (isHovered && !isSelected) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 8;
  }

  // Draw emoji
  const emojiSize = Math.round(size * 0.85);
  ctx.font = `${emojiSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Emoji position (slightly up to make room for index)
  const emojiY = iconInfo.index ? -size * 0.1 : 0;
  ctx.fillText(emoji, 0, emojiY);

  // Reset shadow for text
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.filter = 'none';

  // Draw index subscript below emoji
  if (iconInfo.index) {
    ctx.font = `bold ${Math.round(size * 0.32)}px sans-serif`;
    ctx.fillStyle = isMuted ? 'rgba(80, 80, 80, 0.7)' : 'rgba(40, 40, 40, 0.9)';

    // Add subtle text shadow for readability
    ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
    ctx.shadowBlur = 2;

    ctx.fillText(iconInfo.index, 0, size * 0.42);
  }

  ctx.restore();
}

/**
 * Strings: Violin body silhouette (figure-8 / hourglass)
 */
function drawStringShape(ctx, size) {
  const w = size * 0.5;
  const h = size * 0.5;

  ctx.beginPath();
  // Top curve
  ctx.moveTo(0, -h);
  ctx.bezierCurveTo(w, -h, w, -h * 0.2, w * 0.65, 0);
  // Bottom curve
  ctx.bezierCurveTo(w, h * 0.2, w, h, 0, h);
  ctx.bezierCurveTo(-w, h, -w, h * 0.2, -w * 0.65, 0);
  // Back to top
  ctx.bezierCurveTo(-w, -h * 0.2, -w, -h, 0, -h);
  ctx.closePath();
}

/**
 * Brass: Circle with bell flare (trumpet bell view)
 */
function drawBrassShape(ctx, size) {
  const r = size * 0.42;

  ctx.beginPath();
  // Main circle
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.closePath();

  // Inner ring (bell detail)
  ctx.moveTo(r * 0.6, 0);
  ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2, true);
}

/**
 * Woodwinds: Vertical pill/tube shape
 */
function drawWoodwindShape(ctx, size) {
  const w = size * 0.32;
  const h = size * 0.5;
  const r = w; // Rounded cap radius

  ctx.beginPath();
  // Start from top-left of the body
  ctx.moveTo(-w, -h + r);
  // Top cap
  ctx.arc(0, -h + r, w, Math.PI, 0, false);
  // Right side
  ctx.lineTo(w, h - r);
  // Bottom cap
  ctx.arc(0, h - r, w, 0, Math.PI, false);
  // Left side back to start
  ctx.closePath();
}

/**
 * Percussion: Hexagon (drum top view)
 */
function drawPercussionShape(ctx, size) {
  const r = size * 0.45;
  const sides = 6;

  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
    const px = r * Math.cos(angle);
    const py = r * Math.sin(angle);
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
}

/**
 * Keyboard: Wide rounded rectangle (piano shape)
 */
function drawKeyboardShape(ctx, size) {
  const w = size * 0.55;
  const h = size * 0.35;
  const r = size * 0.1;

  ctx.beginPath();
  ctx.moveTo(-w + r, -h);
  ctx.lineTo(w - r, -h);
  ctx.quadraticCurveTo(w, -h, w, -h + r);
  ctx.lineTo(w, h - r);
  ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(-w + r, h);
  ctx.quadraticCurveTo(-w, h, -w, h - r);
  ctx.lineTo(-w, -h + r);
  ctx.quadraticCurveTo(-w, -h, -w + r, -h);
  ctx.closePath();
}

/**
 * Harp: Triangle frame
 */
function drawHarpShape(ctx, size) {
  const w = size * 0.45;
  const h = size * 0.5;

  ctx.beginPath();
  ctx.moveTo(0, -h);           // Top point
  ctx.lineTo(w, h);            // Bottom right
  ctx.lineTo(-w * 0.3, h);     // Bottom left (asymmetric)
  ctx.closePath();
}

/**
 * Voice: Person silhouette with gender symbol
 * @param {string} gender - 'f' for female (♀), 'm' for male (♂)
 */
function drawVoiceShape(ctx, size, gender) {
  const r = size * 0.42;

  // Head circle
  ctx.beginPath();
  ctx.arc(0, -r * 0.3, r * 0.5, 0, Math.PI * 2);
  ctx.closePath();

  // Body (shoulders)
  ctx.moveTo(-r, r * 0.8);
  ctx.quadraticCurveTo(-r * 0.8, r * 0.2, 0, r * 0.15);
  ctx.quadraticCurveTo(r * 0.8, r * 0.2, r, r * 0.8);
  ctx.lineTo(-r, r * 0.8);
  ctx.closePath();

  // Draw gender symbol as an accent
  ctx.fill();
  ctx.stroke();

  // Gender symbol (drawn separately as accent)
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.5;

  if (gender === 'f') {
    // ♀ Female: circle with cross below (simplified as + at bottom)
    const sy = r * 0.9;
    ctx.moveTo(-size * 0.12, sy);
    ctx.lineTo(size * 0.12, sy);
    ctx.moveTo(0, sy - size * 0.08);
    ctx.lineTo(0, sy + size * 0.08);
  } else {
    // ♂ Male: arrow pointing up-right (simplified)
    const sx = r * 0.7;
    const sy = -r * 0.7;
    ctx.moveTo(sx - size * 0.1, sy + size * 0.1);
    ctx.lineTo(sx, sy);
    ctx.lineTo(sx - size * 0.08, sy);
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx, sy + size * 0.08);
  }
  ctx.stroke();
}

/**
 * Dim a hex color
 */
function dimColor(hex, amount) {
  // Handle rgb format
  if (hex.startsWith('rgb')) {
    const match = hex.match(/(\d+)/g);
    if (match) {
      const [r, g, b] = match.map(Number);
      const gray = (r + g + b) / 3;
      const nr = Math.round(r + (gray - r) * amount);
      const ng = Math.round(g + (gray - g) * amount);
      const nb = Math.round(b + (gray - b) * amount);
      return `rgb(${nr}, ${ng}, ${nb})`;
    }
  }

  // Handle hex format
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
 * Get bounding box for hit testing
 * Emojis are uniformly sized, so bounds are consistent
 * @param {string} shape - Shape type (ignored for emoji system)
 * @param {number} size - Icon size
 * @returns {{ width: number, height: number }}
 */
export function getShapeBounds(shape, size) {
  // Emojis are roughly square, with slight extra height for index subscript
  return { width: size, height: size * 1.2 };
}
