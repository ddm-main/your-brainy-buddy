// Single source of truth for the v4 bucket weights.
//
// This file has no imports and no runtime dependencies on purpose: the edge
// scorer (Deno) and the Calibration Lab (browser/Vite) both import it, so the
// "vs live" deltas the lab draws can never drift from the weights the scorer
// actually used. Change the numbers here and nowhere else.
export const V4_WEIGHTS = {
  volume: 16,
  indicators: 16,
  setups: 13,
  levels: 22,
  strength: 13,
  patterns: 11,
  sentiment: 9,
} as const;

export type V4Bucket = keyof typeof V4_WEIGHTS;
