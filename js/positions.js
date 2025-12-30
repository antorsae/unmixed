// orchestraLayout.js
//
// Realistic, collision-free stage placement for a semi-circular concert platform
// (audience perspective).
//
// Coordinate system (normalized):
//   X: -1.0 (audience left)  to +1.0 (audience right)
//   Y:  0.0 (front edge)     to +1.0 (back wall)
//
// The visual stage in your screenshots is a half-disk. The helpers below keep every
// position inside that half-disk and then run a small collision-relaxation pass so
// markers do not overlap.
//
// Drop-in: keeps the existing exports (DEFAULT_POSITIONS, FAMILY_* , detectFamily,
// lookupDefaultPosition, PROFILES) and adds layoutPositions() for full-ensemble,
// non-overlapping layouts.

/* ---------------------------------------------
 * Stage geometry (matches the semi-circular shell)
 * -------------------------------------------- */

export const STAGE = {
  // Radius of the drawn stage (in your normalized coordinate system).
  // The effective usable radius is (radius - margin).
  // Set to 0.95 to allow full y-depth (percussion at y~0.9)
  radius: 0.95,

  // Keep icons slightly inside the boundary so they don't "touch" the shell.
  margin: 0.05,

  // Minimum distance between two instrument markers (tuned to your icon size).
  minDistance: 0.085,
};

/**
 * Clamp a point to the usable half-disk stage (y >= 0).
 * Keeps y as much as possible and clamps x to the maximum allowed width at that y.
 */
export function clampToStage(pos) {
  const r = Math.max(0.01, STAGE.radius - STAGE.margin);
  let x = pos.x;
  let y = pos.y;

  // Stage is only the front half: y must be within [0, r]
  y = Math.max(0, Math.min(y, r));

  // For a half-circle: x^2 + y^2 <= r^2  => |x| <= sqrt(r^2 - y^2)
  const xMax = Math.sqrt(Math.max(0, r * r - y * y));
  x = Math.max(-xMax, Math.min(x, xMax));

  return { x, y };
}

/* ---------------------------------------------
 * Section parsing (supports your abbreviations)
 * -------------------------------------------- */

/**
 * Convert trailing letter to 0-based index (a->0, b->1, ...).
 */
function letterIndex(ch) {
  const c = (ch || '').toLowerCase();
  if (!c || c < 'a' || c > 'z') return null;
  return c.charCodeAt(0) - 'a'.charCodeAt(0);
}

/**
 * Extract a useful 0-based "seat" index from a name.
 * Examples:
 *  - "Vl1a" -> 0
 *  - "Vl1h" -> 7
 *  - "Cl3"  -> 2
 *  - "Tr 2" -> 1
 *
 * FIX: Only allow trailing-letter seat indices for prefixes that actually use
 * that convention (vl1a, vlaa, kbb, etc.) to avoid "Bassoon" -> seat 13.
 */
function parseSeatIndex(raw) {
  const s = raw.toLowerCase().replace(/\s+/g, '');

  // Only allow trailing-letter seat indices for known prefixes
  const allowLetterSeat = /^(vl\d|vn\d|vln\d|vla|vc|kb|cb|db)/.test(s);

  // Prefer trailing letter for known string section prefixes
  const mLetter = s.match(/([a-z])$/i);
  if (allowLetterSeat && mLetter) {
    const li = letterIndex(mLetter[1]);
    if (li !== null) return li;
  }

  // Otherwise trailing number (Cl3, Ob2, Tr4, Trb2, Corn7, etc.)
  const mNum = s.match(/(\d+)\s*$/);
  if (mNum) {
    const n = Number(mNum[1]);
    if (Number.isFinite(n) && n > 0) return n - 1;
  }

  return 0;
}

/**
 * Classify an instrument name into a "section key" used by the seating template.
 * (This is intentionally a bit permissive to match your dataset labels.)
 */
function sectionKeyFor(name) {
  const s = name.toLowerCase().trim();
  const ss = s.replace(/\s+/g, ''); // squashed version for pattern matching

  // Strings (your dataset uses Vl/Vla/Vc/Kb)
  if (/(^|\b)(violin\s*(i|1)|vln1|vn1|vl1)/i.test(s)) return 'vln1';
  if (/(^|\b)(violin\s*(ii|2)|vln2|vn2|vl2)/i.test(s)) return 'vln2';
  if (/(^|\b)(viola|vla|va)\b/i.test(s) || /^vla/i.test(s)) return 'vla';
  if (/(^|\b)(cello|violoncello|vlc|vc)\b/i.test(s) || /^vc/i.test(s)) return 'vc';
  // "Kb" in the Aalto datasets is Kontrabass (double bass)
  // FIX: Use negative lookahead to avoid matching "bass clarinet", "bass trombone", "bass drum"
  if (
    /(double\s*bass|contrabass|kontrabass)\b/i.test(s) ||
    /\b(cb|db)\b/i.test(s) ||
    /^kb/.test(ss) ||
    /\bbass\b(?!\s*(clarinet|trombone|drum))/i.test(s)
  ) {
    return 'cb';
  }

  // Woodwinds
  if (/(^|\b)(piccolo|picc|ottavino)\b/i.test(s)) return 'picc';
  if (/(^|\b)(flute|fl|flauto)\b/i.test(s) || /^fl\d*/i.test(s)) return 'fl';
  if (/(^|\b)(oboe|ob)\b/i.test(s) || /^ob\d*/i.test(s)) return 'ob';
  if (/(^|\b)(english\s*horn|cor\s*anglais|eh)\b/i.test(s)) return 'eh';
  if (/(^|\b)(bass\s*clarinet|bassclarinet|bcl)\b/i.test(s)) return 'bcl';
  if (/(^|\b)(clarinet|cl|klarinette)\b/i.test(s) || /^cl\d*/i.test(s)) return 'cl';
  if (/(^|\b)(contrabassoon|contrafagott|cbsn)\b/i.test(s)) return 'cbsn';
  if (/(^|\b)(bassoon|bsn|fg|fagott)\b/i.test(s) || /^bsn\d*/i.test(s)) return 'bsn';

  // Brass
  // "Corn" in your screenshots is Horn (corno)
  if (/(^|\b)(french\s*horn|horn|hn|hr|cor)\b/i.test(s) || /^corn/i.test(s)) return 'hn';
  if (/(^|\b)(bass\s*trombone|basstrombone|btrb)\b/i.test(s)) return 'btbn';
  if (/(^|\b)(trombone|trb|tbn|posaune)\b/i.test(s) || /^trb/i.test(s)) return 'tbn';
  // In your dataset "Tr1..Tr4" are trumpets. Check trombone first (Trb).
  // FIX: Also match "Tr 1" with space
  if (/(^|\b)(trumpet|trp|tpt|trompete)\b/i.test(s) || /^tr\d+/i.test(ss) || /^tr\s*\d+/i.test(s)) return 'trp';
  if (/(^|\b)(tuba|tb)\b/i.test(s)) return 'tuba';

  // Percussion
  if (/(^|\b)(timpani|timp|pauken)\b/i.test(s) || /^timp/i.test(s)) return 'timp';
  if (/(^|\b)(percussion|perc|schlagzeug|drum|cymbal|triangle|snare|glockenspiel|xylophone|vibraphone|bassdrum)\b/i.test(s) || /^perc/i.test(s))
    return 'perc';

  // Keyboard / other
  if (/(^|\b)(harp|harfe|arpa)\b/i.test(s)) return 'harp';
  if (/(^|\b)(piano|klavier)\b/i.test(s)) return 'piano';
  if (/(^|\b)(celesta)\b/i.test(s)) return 'celesta';

  // Voice
  if (/(^|\b)(soprano|alto|tenor|baritone|basso|mezzo|voice|vocal|singer|soloist|solo|sopr)\b/i.test(s))
    return 'voice';

  return null;
}

/* ---------------------------------------------
 * Seating template (American / modern standard)
 * -------------------------------------------- */

/**
 * Anchor (section center) positions.
 * Values are chosen to fit comfortably within the half-disk stage.
 * Brass farther back + wider spread; percussion clearly at the back.
 */
const SECTION_ANCHOR = {
  // Strings (front, slightly widened)
  vln1: { x: -0.58, y: 0.16 },
  vln2: { x: -0.26, y: 0.22 },
  vla:  { x:  0.10, y: 0.24 },
  vc:   { x:  0.42, y: 0.26 },
  cb:   { x:  0.62, y: 0.42 },

  // Woodwinds (tiny push back)
  picc: { x: -0.22, y: 0.43 },
  fl:   { x: -0.20, y: 0.38 },
  ob:   { x: -0.02, y: 0.38 },
  eh:   { x:  0.06, y: 0.42 },
  cl:   { x:  0.16, y: 0.41 },
  bcl:  { x:  0.24, y: 0.45 },
  bsn:  { x:  0.34, y: 0.41 },
  cbsn: { x:  0.40, y: 0.45 },

  // Brass (more back + more lateral)
  hn:   { x: -0.48, y: 0.60 },
  trp:  { x:  0.06, y: 0.62 },
  tbn:  { x:  0.46, y: 0.64 },
  btbn: { x:  0.54, y: 0.65 },
  tuba: { x:  0.60, y: 0.66 },

  // Percussion (clearly back)
  timp: { x: -0.12, y: 0.76 },
  perc: { x:  0.24, y: 0.78 },

  // Keyboard / misc
  harp:    { x: -0.72, y: 0.36 },
  piano:   { x: -0.50, y: 0.30 },
  celesta: { x:  0.02, y: 0.74 },

  // Voice / soloist
  voice: { x: 0.00, y: 0.08 },
};

/**
 * Grid parameters per section for deterministic, non-overlapping "seat" offsets.
 * perRow: typical number per row in the section
 * dx/dy: spacing between markers
 * xBias: shifts the mini-grid towards center to avoid stage edge spill
 */
const SECTION_GRID = {
  vln1: { perRow: 4, dx: 0.090, dy: 0.082, xBias: +0.50 },
  vln2: { perRow: 3, dx: 0.090, dy: 0.082, xBias: +0.25 },
  vla:  { perRow: 3, dx: 0.090, dy: 0.082, xBias: -0.10 },
  vc:   { perRow: 2, dx: 0.100, dy: 0.090, xBias: -0.35 },
  cb:   { perRow: 2, dx: 0.100, dy: 0.090, xBias: -0.70 },

  fl:   { perRow: 2, dx: 0.085, dy: 0.080, xBias: +0.20 },
  picc: { perRow: 2, dx: 0.085, dy: 0.080, xBias: +0.20 },
  ob:   { perRow: 2, dx: 0.085, dy: 0.080, xBias:  0.00 },
  eh:   { perRow: 1, dx: 0.085, dy: 0.080, xBias:  0.00 },
  cl:   { perRow: 2, dx: 0.085, dy: 0.080, xBias: -0.10 },
  bcl:  { perRow: 1, dx: 0.085, dy: 0.080, xBias: -0.10 },
  bsn:  { perRow: 2, dx: 0.085, dy: 0.080, xBias: -0.20 },
  cbsn: { perRow: 1, dx: 0.085, dy: 0.080, xBias: -0.20 },

  hn:   { perRow: 4, dx: 0.090, dy: 0.085, xBias: +0.25 },
  trp:  { perRow: 3, dx: 0.090, dy: 0.085, xBias:  0.00 },
  tbn:  { perRow: 2, dx: 0.090, dy: 0.085, xBias: -0.35 },
  btbn: { perRow: 1, dx: 0.090, dy: 0.085, xBias: -0.40 },
  tuba: { perRow: 1, dx: 0.090, dy: 0.085, xBias: -0.45 },

  timp: { perRow: 2, dx: 0.110, dy: 0.100, xBias:  0.00 },
  perc: { perRow: 2, dx: 0.110, dy: 0.100, xBias: -0.15 },

  harp:    { perRow: 1, dx: 0.100, dy: 0.100, xBias: 0.00 },
  piano:   { perRow: 1, dx: 0.100, dy: 0.100, xBias: 0.00 },
  celesta: { perRow: 1, dx: 0.100, dy: 0.100, xBias: 0.00 },

  voice: { perRow: 2, dx: 0.110, dy: 0.070, xBias: 0.00 },
};

/**
 * Small deterministic offset within a section, based on a seat index.
 */
function offsetInSection(sectionKey, seatIndex) {
  const g = SECTION_GRID[sectionKey] || { perRow: 1, dx: 0.09, dy: 0.085, xBias: 0 };
  const perRow = Math.max(1, g.perRow);
  const row = Math.floor(seatIndex / perRow);
  const col = seatIndex % perRow;

  // Center the columns around 0, then bias slightly towards the stage center.
  const centeredCol = col - (perRow - 1) / 2;
  const x = (centeredCol + g.xBias) * g.dx;

  // Rows go "back" (higher y) as the index increases.
  const y = row * g.dy;

  return { x, y };
}

/* ---------------------------------------------
 * Default positions (anchors) — updated & realistic
 * -------------------------------------------- */

// Default orchestral positions based on modern "American" seating (audience perspective)
// These are *centers* of each section. If your instrument labels include indices
// (e.g. "Vl1a", "Cl2", "Corn7"), lookupDefaultPosition() will automatically
// apply deterministic offsets to avoid overlaps.
export const DEFAULT_POSITIONS = {
  // --- Strings (front) ---
  'violin i': { ...SECTION_ANCHOR.vln1 },
  'violin 1': { ...SECTION_ANCHOR.vln1 },
  'violin1': { ...SECTION_ANCHOR.vln1 },
  '1st violin': { ...SECTION_ANCHOR.vln1 },
  'first violin': { ...SECTION_ANCHOR.vln1 },
  'vln1': { ...SECTION_ANCHOR.vln1 },
  'vn1': { ...SECTION_ANCHOR.vln1 },
  'vl1': { ...SECTION_ANCHOR.vln1 },

  'violin ii': { ...SECTION_ANCHOR.vln2 },
  'violin 2': { ...SECTION_ANCHOR.vln2 },
  'violin2': { ...SECTION_ANCHOR.vln2 },
  '2nd violin': { ...SECTION_ANCHOR.vln2 },
  'second violin': { ...SECTION_ANCHOR.vln2 },
  'vln2': { ...SECTION_ANCHOR.vln2 },
  'vn2': { ...SECTION_ANCHOR.vln2 },
  'vl2': { ...SECTION_ANCHOR.vln2 },

  'violin': { x: -0.34, y: 0.19 }, // generic / unspecified

  'viola': { ...SECTION_ANCHOR.vla },
  'vla': { ...SECTION_ANCHOR.vla },
  'va': { ...SECTION_ANCHOR.vla },

  'cello': { ...SECTION_ANCHOR.vc },
  'violoncello': { ...SECTION_ANCHOR.vc },
  'vc': { ...SECTION_ANCHOR.vc },
  'vlc': { ...SECTION_ANCHOR.vc },

  'contrabass': { ...SECTION_ANCHOR.cb },
  'double bass': { ...SECTION_ANCHOR.cb },
  'bass': { ...SECTION_ANCHOR.cb },
  'cb': { ...SECTION_ANCHOR.cb },
  'db': { ...SECTION_ANCHOR.cb },
  'kontrabass': { ...SECTION_ANCHOR.cb },
  'kb': { ...SECTION_ANCHOR.cb },

  // --- Woodwinds (middle) ---
  'piccolo': { ...SECTION_ANCHOR.picc },
  'picc': { ...SECTION_ANCHOR.picc },
  'ottavino': { ...SECTION_ANCHOR.picc },

  'flute': { ...SECTION_ANCHOR.fl },
  'fl': { ...SECTION_ANCHOR.fl },
  'flauto': { ...SECTION_ANCHOR.fl },

  'oboe': { ...SECTION_ANCHOR.ob },
  'ob': { ...SECTION_ANCHOR.ob },

  'english horn': { ...SECTION_ANCHOR.eh },
  'cor anglais': { ...SECTION_ANCHOR.eh },
  'englishhorn': { ...SECTION_ANCHOR.eh },
  'eh': { ...SECTION_ANCHOR.eh },

  'clarinet': { ...SECTION_ANCHOR.cl },
  'cl': { ...SECTION_ANCHOR.cl },
  'klarinette': { ...SECTION_ANCHOR.cl },

  'bass clarinet': { ...SECTION_ANCHOR.bcl },
  'bassclarinet': { ...SECTION_ANCHOR.bcl },
  'bcl': { ...SECTION_ANCHOR.bcl },

  'bassoon': { ...SECTION_ANCHOR.bsn },
  'bsn': { ...SECTION_ANCHOR.bsn },
  'fg': { ...SECTION_ANCHOR.bsn },
  'fagott': { ...SECTION_ANCHOR.bsn },

  'contrabassoon': { ...SECTION_ANCHOR.cbsn },
  'contrafagott': { ...SECTION_ANCHOR.cbsn },
  'cbsn': { ...SECTION_ANCHOR.cbsn },

  // --- Brass (back) ---
  'french horn': { ...SECTION_ANCHOR.hn },
  'horn': { ...SECTION_ANCHOR.hn },
  'hr': { ...SECTION_ANCHOR.hn },
  'hn': { ...SECTION_ANCHOR.hn },
  'cor': { ...SECTION_ANCHOR.hn },
  'corn': { ...SECTION_ANCHOR.hn }, // corno/horn label in your screenshots

  'trumpet': { ...SECTION_ANCHOR.trp },
  'trp': { ...SECTION_ANCHOR.trp },
  'tr': { ...SECTION_ANCHOR.trp },   // "Tr1..Tr4"
  'tpt': { ...SECTION_ANCHOR.trp },
  'trompete': { ...SECTION_ANCHOR.trp },

  'trombone': { ...SECTION_ANCHOR.tbn },
  'trb': { ...SECTION_ANCHOR.tbn },
  'tbn': { ...SECTION_ANCHOR.tbn },
  'posaune': { ...SECTION_ANCHOR.tbn },

  'bass trombone': { ...SECTION_ANCHOR.btbn },
  'basstrombone': { ...SECTION_ANCHOR.btbn },
  'btrb': { ...SECTION_ANCHOR.btbn },

  'tuba': { ...SECTION_ANCHOR.tuba },
  'tb': { ...SECTION_ANCHOR.tuba },

  // --- Percussion (rear) ---
  'timpani': { ...SECTION_ANCHOR.timp },
  'timp': { ...SECTION_ANCHOR.timp },
  'pauken': { ...SECTION_ANCHOR.timp },

  'percussion': { ...SECTION_ANCHOR.perc },
  'perc': { ...SECTION_ANCHOR.perc },
  'schlagzeug': { ...SECTION_ANCHOR.perc },

  // Percussion items relative to new perc anchor (x: 0.24, y: 0.78)
  'cymbals': { x: 0.36, y: 0.76 },
  'cymbal': { x: 0.36, y: 0.76 },
  'triangle': { x: 0.14, y: 0.76 },
  'bass drum': { x: 0.24, y: 0.82 },
  'bassdrum': { x: 0.24, y: 0.82 },
  'snare': { x: 0.24, y: 0.74 },
  'snare drum': { x: 0.24, y: 0.74 },
  'glockenspiel': { x: 0.14, y: 0.79 },
  'xylophone': { x: 0.18, y: 0.80 },
  'vibraphone': { x: 0.22, y: 0.80 },

  // --- Keyboard / other ---
  'celesta': { ...SECTION_ANCHOR.celesta },

  'harp': { ...SECTION_ANCHOR.harp },
  'harfe': { ...SECTION_ANCHOR.harp },
  'arpa': { ...SECTION_ANCHOR.harp },

  'piano': { ...SECTION_ANCHOR.piano },
  'klavier': { ...SECTION_ANCHOR.piano },

  // --- Voice ---
  'soprano': { ...SECTION_ANCHOR.voice },
  'soloist': { ...SECTION_ANCHOR.voice },
  'solo': { ...SECTION_ANCHOR.voice },
  'vocal': { ...SECTION_ANCHOR.voice },
  'voice': { ...SECTION_ANCHOR.voice },
  'singer': { ...SECTION_ANCHOR.voice },
  'alto': { x: -0.08, y: 0.09 },
  'mezzo': { x: -0.04, y: 0.09 },
  'tenor': { x: 0.08, y: 0.09 },
  'baritone': { x: 0.12, y: 0.10 },
  'basso': { x: 0.16, y: 0.10 },
};

/* ---------------------------------------------
 * Instrument family detection patterns
 * (extended for your abbreviated dataset labels)
 * -------------------------------------------- */

export const FAMILY_PATTERNS = {
  // include: Vl1a/Vl2b, Vla*, Vc*, Kb* (Kontrabass)
  // FIX: Use negative lookahead to avoid matching "bass clarinet", "bass trombone", "bass drum"
  strings: /violin|viola|cello|violoncello|contrabass|double\s*bass|kontrabass|\b(cb|db|kb)\b|\bbass\b(?!\s*(clarinet|trombone|drum))|vln|vn|vl\d|vla|va\b|vc\b|vlc/i,
  woodwinds: /flute|piccolo|oboe|clarinet|bassoon|english\s*horn|cor\s*anglais|ottavino|flauto|klarinette|fagott|\bfl\b|\bob\b|\bcl\b|\bbsn\b|\bfg\b|\bpicc\b|\beh\b/i,
  brass: /horn|trumpet|trombone|tuba|corn|hn\b|hr\b|cor\b|trp\b|\btr\b|tpt\b|trb\b|tbn\b|\btb\b/i,
  percussion: /timpani|timp\b|percussion|perc\b|drum|cymbal|triangle|glockenspiel|xylophone|vibraphone|pauken|schlagzeug/i,
  keyboard: /piano|harp|celesta|harfe|klavier|keyboard|organ/i,
  voice: /soprano|alto|tenor|baritone|mezzo|voice|vocal|singer|soloist|solo|choir|chorus|sopr/i,
};

// Family display order
export const FAMILY_ORDER = ['strings', 'woodwinds', 'brass', 'percussion', 'keyboard', 'voice'];

// Family colors (warm orchestral palette)
export const FAMILY_COLORS = {
  strings: '#8B4513',
  woodwinds: '#6B8E23',
  brass: '#DAA520',
  percussion: '#4682B4',
  keyboard: '#663399',
  voice: '#DC143C',
};

/**
 * Detect the instrument family from a name.
 * @param {string} name - Instrument name
 * @returns {string} - Family name
 */
export function detectFamily(name) {
  const lower = (name || '').toLowerCase();

  for (const [family, pattern] of Object.entries(FAMILY_PATTERNS)) {
    if (pattern.test(lower)) return family;
  }

  return 'strings'; // Default fallback
}

/* ---------------------------------------------
 * Collision-free ensemble placement
 * -------------------------------------------- */

/**
 * Resolve overlaps among already-initialized positions.
 * Mutates `items` in place.
 */
function relaxCollisions(items, { minDistance = STAGE.minDistance, iterations = 60 } = {}) {
  const minD = Math.max(0.01, minDistance);

  for (let it = 0; it < iterations; it++) {
    let moved = false;

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const dx = a.pos.x - b.pos.x;
        const dy = a.pos.y - b.pos.y;
        const d2 = dx * dx + dy * dy;

        if (d2 === 0) {
          // Perfect overlap: nudge deterministically
          a.pos.x += 0.002;
          a.pos.y += 0.001;
          b.pos.x -= 0.002;
          b.pos.y -= 0.001;
          moved = true;
          continue;
        }

        const d = Math.sqrt(d2);
        if (d < minD) {
          const push = (minD - d) / d * 0.5;
          a.pos.x += dx * push;
          a.pos.y += dy * push;
          b.pos.x -= dx * push;
          b.pos.y -= dy * push;
          moved = true;
        }
      }
    }

    // Keep everything on stage
    for (const it of items) it.pos = clampToStage(it.pos);

    if (!moved) break;
  }
}

/**
 * Layout an entire orchestra (or any ensemble list) with realistic seating and no overlap.
 *
 * @param {string[]} instrumentNames
 * @param {{ minDistance?: number }} [opts]
 * @returns {Record<string, {x:number,y:number}>} mapping name -> position
 */
export function layoutPositions(instrumentNames, opts = {}) {
  const names = Array.isArray(instrumentNames) ? instrumentNames.slice() : [];
  // Stable ordering improves determinism
  names.sort((a, b) => String(a).localeCompare(String(b)));

  const items = names.map((name) => ({ name, pos: lookupDefaultPosition(name) }));

  relaxCollisions(items, { minDistance: opts.minDistance ?? STAGE.minDistance });

  const out = {};
  for (const it of items) out[it.name] = it.pos;
  return out;
}

/* ---------------------------------------------
 * Position lookup (single instrument)
 * -------------------------------------------- */

/**
 * Look up a realistic default position for an instrument name.
 * - Handles synonyms and your dataset abbreviations (Vl1a, Corn7, Trb2, etc.)
 * - Keeps the point inside the semi-circular stage
 * - Applies a deterministic intra-section offset (so indexed labels don't overlap)
 *
 * @param {string} name - Instrument name
 * @returns {{x:number,y:number}} - Default position
 */
export function lookupDefaultPosition(name) {
  const raw = String(name || '');
  const lower = raw.toLowerCase().trim();
  const squashed = lower.replace(/\s+/g, '');

  // 1) Try exact match in DEFAULT_POSITIONS
  if (DEFAULT_POSITIONS[lower]) {
    return clampToStage({ ...DEFAULT_POSITIONS[lower] });
  }

  // 2) Try section-based template (supports Vl1a, Cl2, Corn7, etc.)
  const sk = sectionKeyFor(raw);
  if (sk && SECTION_ANCHOR[sk]) {
    const seat = parseSeatIndex(raw);
    const o = offsetInSection(sk, seat);
    const base = SECTION_ANCHOR[sk];
    return clampToStage({ x: base.x + o.x, y: base.y + o.y });
  }

  // 3) Try partial matches against DEFAULT_POSITIONS keys
  for (const [key, pos] of Object.entries(DEFAULT_POSITIONS)) {
    if (lower.includes(key) || key.includes(lower) || squashed.includes(key.replace(/\s+/g, ''))) {
      return clampToStage({ ...pos });
    }
  }

  // 4) Family-based fallback (kept within the stage)
  const family = detectFamily(raw);
  const familyDefaults = {
    strings: { x: 0.00, y: 0.22 },
    woodwinds: { x: 0.00, y: 0.38 },
    brass: { x: 0.00, y: 0.54 },
    percussion: { x: 0.10, y: 0.62 },
    keyboard: { x: -0.40, y: 0.36 },
    voice: { x: 0.00, y: 0.08 },
  };

  return clampToStage(familyDefaults[family] || { x: 0.00, y: 0.10 });
}

/* ---------------------------------------------
 * Profile metadata (unchanged)
 * -------------------------------------------- */

export const PROFILES = {
  mozart: {
    name: 'Mozart - Don Giovanni',
    fullName: 'W.A. Mozart: Don Giovanni - Donna Elvira aria',
    url: 'https://mediatech.aalto.fi/images/research/virtualacoustics/recordings/mozart_mp3.zip',
    size: '72 MB',
  },
  beethoven: {
    name: 'Beethoven - Symphony No. 7',
    fullName: 'L. van Beethoven: Symphony No. 7, I mvt, bars 1-53',
    url: 'https://mediatech.aalto.fi/images/research/virtualacoustics/recordings/beethoven_mp3.zip',
    size: '109 MB',
  },
  bruckner: {
    name: 'Bruckner - Symphony No. 8',
    fullName: 'A. Bruckner: Symphony No. 8, II mvt, bars 1-61',
    url: 'https://mediatech.aalto.fi/images/research/virtualacoustics/recordings/bruckner_mp3.zip',
    size: '115 MB',
  },
  mahler: {
    name: 'Mahler - Symphony No. 1',
    fullName: 'G. Mahler: Symphony No. 1, IV mvt, bars 1-85',
    url: 'https://mediatech.aalto.fi/images/research/virtualacoustics/recordings/mahler_mp3.zip',
    size: '150 MB',
  },
};
