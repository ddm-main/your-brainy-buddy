// Single source of truth for the v4 bucket weights.
//
// This file has no imports and no runtime dependencies on purpose: the edge
// scorer (Deno) and the Calibration Lab (browser/Vite) both import it, so the
// "vs live" deltas the lab draws can never drift from the weights the scorer
// actually used. Change the numbers here and nowhere else.
//
// 2026-08-10 — `sentiment` was removed as a bucket. It was covered on 14 of
// 1,632 scored rows (news and AI coverage are effectively empty), so its 9
// points were renormalised away on every other row: coverage sat at 0.91 on
// the whole universe, the renorm cap (0.85) never bit, and 91 points were
// scaled up to a published 100. A bucket that is never measured must not sit
// in the published weight table. Its 9 points are redistributed explicitly
// here, and sentiment now applies as a bounded multiplier (see
// V4_SENTIMENT_MULT_* in scoring.ts) so the signal is still used when it
// exists without inflating anything when it doesn't.
//
// 2026-08-10 (second pass) — `patterns` removed for the opposite reason: it
// reported full coverage on every row yet paid an average 1.1 of its 12
// points (raw value 0.095), i.e. a near-constant occupying 12% of the model,
// and its detector output is not trustworthy enough to price. The 12 points
// are redistributed toward what decides a multi-week swing: the entry level,
// the participation behind it, the trend structure being ridden, and
// leadership. Oscillators are timing, not thesis, so indicators gives ground.
export const V4_WEIGHTS = {
  levels: 26,
  volume: 20,
  setups: 20,
  strength: 18,
  indicators: 16,
} as const;


export type V4Bucket = keyof typeof V4_WEIGHTS;
