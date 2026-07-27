// Score display / decision bands — client-side mirror of the constants in
// supabase/functions/_shared/market/scoring.ts (SCORE_BAND_* /
// BREAKOUT_QUALIFY_SCORE). Edge functions and the UI must agree: if you retune
// one, retune the other in the same change.
export const SCORE_BAND_STRONG = 70;   // 70+   strong / qualifies for the breakout tracker
export const SCORE_BAND_MODERATE = 55; // 55-69 moderate
export const SCORE_BAND_WEAK = 40;     // 40-54 weak
