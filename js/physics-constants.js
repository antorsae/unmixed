// Shared physical constants for the audio simulation

export const MIC_CONSTANTS = {
  refDistance: 3,   // meters (normalization reference for 1/d law)
  minDistance: 0.5, // meters (minimum allowed source distance)
};

// Stage dimensions (meters)
export const STAGE_CONFIG = {
  width: 20,        // -10m to +10m
  depth: 15,        // 0 to 15m from audience
  micSpacing: 2,    // 2m between L and R mics
  micY: -1,         // Mics are 1m in front of stage edge (in audience)
  sourceHeight: 1.2, // Average instrument height
  micHeight: 1.5,   // Mic/ear height
  groundReflectionCoeff: 0.7, // Ground absorption (0=absorptive, 1=reflective)
};

// Air absorption coefficients in dB per 100 meters at different frequencies
// Based on ISO 9613-1 at 20°C, 50% relative humidity
export const AIR_ABSORPTION = [
  { freq: 250, alpha: 0.1 },
  { freq: 500, alpha: 0.3 },
  { freq: 1000, alpha: 0.6 },
  { freq: 2000, alpha: 1.3 },
  { freq: 4000, alpha: 2.8 },
  { freq: 8000, alpha: 7.0 },
  { freq: 16000, alpha: 22.0 },
];
