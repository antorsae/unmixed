// Track filename parsing and instrument detection

import { detectFamily, lookupDefaultPosition, calculateSpreadX } from './positions.js';

/**
 * Parse an instrument name from a filename
 * @param {string} filename - Original filename (e.g., 'violin1_6.mp3')
 * @returns {Object} - Parsed track info
 */
export function parseTrackFilename(filename) {
  // Remove path if present
  let name = filename.split('/').pop().split('\\').pop();

  // Remove extension
  name = name.replace(/\.(mp3|wav|flac|ogg|aac|m4a|webm)$/i, '');

  // Extract mic number if present (e.g., "_6" at end)
  const micMatch = name.match(/_(\d+)$/);
  const micPosition = micMatch ? micMatch[1] : '6';
  name = name.replace(/_\d+$/, '');

  // Extract instance number if present
  const instanceMatch = name.match(/[_\s]?(\d+)$/);
  let instanceNumber = null;
  if (instanceMatch) {
    instanceNumber = parseInt(instanceMatch[1], 10);
    name = name.replace(/[_\s]?\d+$/, '');
  }

  // Also check for roman numerals
  const romanMatch = name.match(/[_\s]?(i{1,3}|iv|vi{0,3})$/i);
  if (romanMatch && !instanceNumber) {
    const roman = romanMatch[1].toLowerCase();
    const romanMap = { 'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8 };
    instanceNumber = romanMap[roman] || null;
    name = name.replace(/[_\s]?(i{1,3}|iv|vi{0,3})$/i, '');
  }

  // Normalize separators to spaces
  name = name.replace(/[-_]+/g, ' ').trim();

  // Capitalize first letter of each word
  const displayName = name
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  // Add instance number back to display name if present
  const fullDisplayName = instanceNumber
    ? `${displayName} ${instanceNumber}`
    : displayName;

  // Detect family
  const family = detectFamily(name);

  // Get default position
  const basePosition = lookupDefaultPosition(name);

  return {
    originalFilename: filename,
    baseName: name.toLowerCase(),
    displayName: fullDisplayName,
    micPosition,
    instanceNumber,
    family,
    defaultX: basePosition.x,
    defaultY: basePosition.y,
  };
}

/**
 * Group tracks by base instrument name for spreading
 * @param {Array} parsedTracks - Array of parsed track info objects
 * @returns {Array} - Tracks with adjusted positions for spreading
 */
export function applyInstanceSpreading(parsedTracks) {
  // Group by base name
  const groups = new Map();

  for (const track of parsedTracks) {
    const key = track.baseName;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(track);
  }

  // Apply spreading within each group
  const result = [];

  for (const [, groupTracks] of groups) {
    // Sort by instance number
    groupTracks.sort((a, b) => {
      const aNum = a.instanceNumber || 0;
      const bNum = b.instanceNumber || 0;
      return aNum - bNum;
    });

    const count = groupTracks.length;

    for (let i = 0; i < groupTracks.length; i++) {
      const track = groupTracks[i];
      const adjustedX = calculateSpreadX(track.defaultX, i, count);

      result.push({
        ...track,
        defaultX: adjustedX,
      });
    }
  }

  return result;
}

/**
 * Group tracks by mic position for the same instrument
 * @param {Array} parsedTracks - Array of parsed track info
 * @returns {Map} - Map of base key to array of mic variants
 */
export function groupByMicPosition(parsedTracks) {
  const groups = new Map();

  for (const track of parsedTracks) {
    // Create key without mic position
    const key = `${track.baseName}_${track.instanceNumber || ''}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(track);
  }

  return groups;
}

/**
 * Get a display label for a mic position
 * @param {string} micPos - Mic position number as string
 * @returns {string} - Display label
 */
export function getMicLabel(micPos) {
  const labels = {
    '5': 'Top (mic 5)',
    '6': 'Front (mic 6)',
    '8': 'Bell/Rear (mic 8)',
  };

  return labels[micPos] || `Mic ${micPos}`;
}

/**
 * Generate a unique ID for a track
 * @param {string} filename - Original filename
 * @returns {string} - Unique ID
 */
export function generateTrackId(filename) {
  // Remove extension and special chars, add random suffix for uniqueness
  const base = filename
    .replace(/\.(mp3|wav|flac|ogg|aac|m4a|webm)$/i, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toLowerCase();

  const random = Math.random().toString(36).substring(2, 8);

  return `${base}_${random}`;
}

/**
 * Sort tracks by family and then by position
 * @param {Array} tracks - Array of track objects
 * @returns {Array} - Sorted tracks
 */
export function sortTracksByFamily(tracks) {
  const familyOrder = ['strings', 'woodwinds', 'brass', 'percussion', 'keyboard', 'voice'];

  return [...tracks].sort((a, b) => {
    const familyA = familyOrder.indexOf(a.family);
    const familyB = familyOrder.indexOf(b.family);

    if (familyA !== familyB) {
      return familyA - familyB;
    }

    // Within same family, sort by X position (left to right)
    if (a.defaultX !== b.defaultX) {
      return a.defaultX - b.defaultX;
    }

    // Then by Y position (front to back)
    return a.defaultY - b.defaultY;
  });
}
