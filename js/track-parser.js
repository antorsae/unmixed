// Track filename parsing and instrument detection

import { detectFamily, lookupDefaultPosition } from './positions.js';

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
