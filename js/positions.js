// Default orchestral positions based on American seating (audience perspective)
// X: -1.0 (left) to +1.0 (right)
// Y: 0.0 (front/close) to 1.0 (back/distant)

export const DEFAULT_POSITIONS = {
  // Strings (Front)
  'violin i': { x: -0.70, y: 0.15 },
  'violin 1': { x: -0.70, y: 0.15 },
  'violin1': { x: -0.70, y: 0.15 },
  '1st violin': { x: -0.70, y: 0.15 },
  'first violin': { x: -0.70, y: 0.15 },
  'vln1': { x: -0.70, y: 0.15 },
  'vn1': { x: -0.70, y: 0.15 },

  'violin ii': { x: -0.30, y: 0.20 },
  'violin 2': { x: -0.30, y: 0.20 },
  'violin2': { x: -0.30, y: 0.20 },
  '2nd violin': { x: -0.30, y: 0.20 },
  'second violin': { x: -0.30, y: 0.20 },
  'vln2': { x: -0.30, y: 0.20 },
  'vn2': { x: -0.30, y: 0.20 },

  'violin': { x: -0.50, y: 0.17 }, // Generic violin

  'viola': { x: 0.30, y: 0.20 },
  'vla': { x: 0.30, y: 0.20 },
  'va': { x: 0.30, y: 0.20 },

  'cello': { x: 0.60, y: 0.25 },
  'violoncello': { x: 0.60, y: 0.25 },
  'vc': { x: 0.60, y: 0.25 },
  'vlc': { x: 0.60, y: 0.25 },

  'contrabass': { x: 0.85, y: 0.35 },
  'double bass': { x: 0.85, y: 0.35 },
  'bass': { x: 0.85, y: 0.35 },
  'cb': { x: 0.85, y: 0.35 },
  'db': { x: 0.85, y: 0.35 },
  'kontrabass': { x: 0.85, y: 0.35 },

  // Woodwinds (Middle)
  'flute': { x: -0.25, y: 0.40 },
  'fl': { x: -0.25, y: 0.40 },
  'flauto': { x: -0.25, y: 0.40 },

  'piccolo': { x: -0.35, y: 0.42 },
  'picc': { x: -0.35, y: 0.42 },
  'ottavino': { x: -0.35, y: 0.42 },

  'oboe': { x: 0.05, y: 0.40 },
  'ob': { x: 0.05, y: 0.40 },

  'english horn': { x: 0.15, y: 0.42 },
  'cor anglais': { x: 0.15, y: 0.42 },
  'englishhorn': { x: 0.15, y: 0.42 },
  'eh': { x: 0.15, y: 0.42 },

  'clarinet': { x: -0.15, y: 0.50 },
  'cl': { x: -0.15, y: 0.50 },
  'klarinette': { x: -0.15, y: 0.50 },

  'bass clarinet': { x: -0.05, y: 0.52 },
  'bassclarinet': { x: -0.05, y: 0.52 },
  'bcl': { x: -0.05, y: 0.52 },

  'bassoon': { x: 0.25, y: 0.50 },
  'bsn': { x: 0.25, y: 0.50 },
  'fg': { x: 0.25, y: 0.50 },
  'fagott': { x: 0.25, y: 0.50 },

  'contrabassoon': { x: 0.35, y: 0.52 },
  'contrafagott': { x: 0.35, y: 0.52 },
  'cbsn': { x: 0.35, y: 0.52 },

  // Brass (Back)
  'french horn': { x: -0.55, y: 0.60 },
  'horn': { x: -0.55, y: 0.60 },
  'hr': { x: -0.55, y: 0.60 },
  'hn': { x: -0.55, y: 0.60 },
  'cor': { x: -0.55, y: 0.60 },

  'trumpet': { x: 0.10, y: 0.70 },
  'trp': { x: 0.10, y: 0.70 },
  'tr': { x: 0.10, y: 0.70 },
  'tpt': { x: 0.10, y: 0.70 },
  'trompete': { x: 0.10, y: 0.70 },

  'trombone': { x: 0.40, y: 0.72 },
  'trb': { x: 0.40, y: 0.72 },
  'tbn': { x: 0.40, y: 0.72 },
  'posaune': { x: 0.40, y: 0.72 },

  'bass trombone': { x: 0.50, y: 0.74 },
  'basstrombone': { x: 0.50, y: 0.74 },
  'btrb': { x: 0.50, y: 0.74 },

  'tuba': { x: 0.60, y: 0.75 },
  'tb': { x: 0.60, y: 0.75 },

  // Percussion (Far Back)
  'timpani': { x: 0.00, y: 0.85 },
  'timp': { x: 0.00, y: 0.85 },
  'pauken': { x: 0.00, y: 0.85 },

  'percussion': { x: 0.30, y: 0.90 },
  'perc': { x: 0.30, y: 0.90 },
  'schlagzeug': { x: 0.30, y: 0.90 },

  'cymbals': { x: 0.40, y: 0.88 },
  'cymbal': { x: 0.40, y: 0.88 },

  'triangle': { x: 0.20, y: 0.88 },

  'bass drum': { x: 0.10, y: 0.90 },
  'bassdrum': { x: 0.10, y: 0.90 },

  'snare': { x: 0.35, y: 0.88 },
  'snare drum': { x: 0.35, y: 0.88 },

  'glockenspiel': { x: 0.25, y: 0.85 },
  'xylophone': { x: 0.20, y: 0.85 },
  'vibraphone': { x: 0.15, y: 0.85 },
  'celesta': { x: -0.60, y: 0.45 },

  // Keyboard
  'harp': { x: -0.80, y: 0.45 },
  'harfe': { x: -0.80, y: 0.45 },
  'arpa': { x: -0.80, y: 0.45 },

  'piano': { x: -0.75, y: 0.30 },
  'klavier': { x: -0.75, y: 0.30 },

  // Voice
  'soprano': { x: 0.00, y: 0.05 },
  'soloist': { x: 0.00, y: 0.05 },
  'solo': { x: 0.00, y: 0.05 },
  'vocal': { x: 0.00, y: 0.05 },
  'voice': { x: 0.00, y: 0.05 },
  'singer': { x: 0.00, y: 0.05 },

  'alto': { x: -0.20, y: 0.08 },
  'mezzo': { x: -0.10, y: 0.06 },
  'tenor': { x: 0.20, y: 0.08 },
  'baritone': { x: 0.30, y: 0.10 },
  'basso': { x: 0.40, y: 0.10 },
};

// Instrument family detection patterns
export const FAMILY_PATTERNS = {
  strings: /violin|viola|cello|violoncello|bass|contrabass|vln|vn|vla|va|vc|vlc|cb|db/i,
  woodwinds: /flute|piccolo|oboe|clarinet|bassoon|english\s*horn|cor\s*anglais|fl|ob|cl|bsn|fg|picc|eh/i,
  brass: /horn|trumpet|trombone|tuba|hr|hn|cor|trp|tr|tpt|trb|tbn|tb/i,
  percussion: /timpani|percussion|perc|drum|cymbal|triangle|glockenspiel|xylophone|vibraphone|timp|schlagzeug/i,
  keyboard: /piano|harp|celesta|harfe|klavier|keyboard|organ/i,
  voice: /soprano|alto|tenor|bass|baritone|mezzo|voice|vocal|singer|soloist|solo|choir|chorus/i,
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
 * Detect the instrument family from a name
 * @param {string} name - Instrument name
 * @returns {string} - Family name
 */
export function detectFamily(name) {
  const lower = name.toLowerCase();

  for (const [family, pattern] of Object.entries(FAMILY_PATTERNS)) {
    if (pattern.test(lower)) {
      return family;
    }
  }

  return 'strings'; // Default fallback
}

/**
 * Look up default position for an instrument
 * @param {string} name - Instrument name
 * @returns {{x: number, y: number}} - Default position
 */
export function lookupDefaultPosition(name) {
  const lower = name.toLowerCase().trim();

  // Try exact match first
  if (DEFAULT_POSITIONS[lower]) {
    return { ...DEFAULT_POSITIONS[lower] };
  }

  // Try partial matches
  for (const [key, pos] of Object.entries(DEFAULT_POSITIONS)) {
    if (lower.includes(key) || key.includes(lower)) {
      return { ...pos };
    }
  }

  // Try family-based default
  const family = detectFamily(name);
  const familyDefaults = {
    strings: { x: 0.00, y: 0.20 },
    woodwinds: { x: 0.00, y: 0.45 },
    brass: { x: 0.00, y: 0.65 },
    percussion: { x: 0.00, y: 0.87 },
    keyboard: { x: -0.70, y: 0.40 },
    voice: { x: 0.00, y: 0.05 },
  };

  if (familyDefaults[family]) {
    return { ...familyDefaults[family] };
  }

  // Ultimate fallback: center front
  return { x: 0.00, y: 0.10 };
}

/**
 * Get profile metadata
 */
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
