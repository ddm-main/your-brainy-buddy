// Score display / decision bands — client-side mirror of the constants in
// supabase/functions/_shared/market/scoring.ts (SCORE_BAND_* /
// BREAKOUT_QUALIFY_SCORE). Edge functions and the UI must agree: if you retune
// one, retune the other in the same change.
export const SCORE_BAND_STRONG = 70;   // 70+   strong / qualifies for the breakout tracker
export const SCORE_BAND_MODERATE = 55; // 55-69 moderate
export const SCORE_BAND_WEAK = 40;     // 40-54 weak

// Episode lifecycle thresholds — mirror of nextEpisodeStatus() in scoring.ts.
// The Breakout legend builds its wording from these instead of restating the
// numbers in prose (tests/breakoutEpisode.test.ts asserts they still match).
export const EXTEND_PCT = 8;      // return since entry that marks the move "run"
export const FAIL_PCT = 6;        // drawdown from entry that fails the breakout
export const COOL_DAYS = 3;       // sessions below the qualify score before cooling
export const MAX_TRACK_DAYS = 15; // tracking horizon in sessions


export interface ScoreBandCuts {
  trade_date: string;
  strong_cut: number | null;
  moderate_cut: number | null;
  watch_cut: number | null;
  n: number;
}

export type ScoreBand = "strong" | "moderate" | "watch" | "weak";

/**
 * Band for a score. When the latest daily distribution row is available the
 * day's own percentile cut-offs (top 2 / 10 / 25%) decide the band — the same
 * rule the scorer and market_score_history now use. The absolute 70/55/40
 * constants remain the fallback for sessions with no distribution row yet, so
 * a chip never goes blank.
 */
export function bandOf(score: number, cuts?: ScoreBandCuts | null): ScoreBand {
  const strong = cuts?.strong_cut ?? SCORE_BAND_STRONG;
  const moderate = cuts?.moderate_cut ?? SCORE_BAND_MODERATE;
  const watch = cuts?.watch_cut ?? SCORE_BAND_WEAK;
  if (score >= strong) return "strong";
  if (score >= moderate) return "moderate";
  if (score >= watch) return "watch";
  return "weak";
}

export const BAND_COLOR: Record<ScoreBand, string> = {
  strong: "var(--ok)",
  moderate: "var(--accent)",
  watch: "var(--warn)",
  weak: "var(--danger)",
};

/** Chip tone per band — keeps every band chip in the app on one mapping. */
export const BAND_TONE: Record<ScoreBand, "ok" | "warn" | "err" | undefined> = {
  strong: "ok",
  moderate: undefined,
  watch: "warn",
  weak: "err",
};

/** Uppercase display label for a band (stored bands come back lowercase). */
export function bandLabel(band: ScoreBand): string {
  return band.toUpperCase();
}
