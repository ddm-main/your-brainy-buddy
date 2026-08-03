// Breakout episode bookkeeping that must survive a re-run of the same session.
//
// The aggregates pass can run several times for one trading session (post-close
// sync, retries, manual kicks). Every counter on a tracker episode is a
// *per-session* counter, so a naive second tick marches days_tracked and
// below_threshold_days forward until the episode cools on its own re-runs —
// which is exactly what happened in production before this reconciliation
// existed. It lives here, isolated and unit-tested, instead of inline in the
// 1,100-line pipeline where it was invisible.

export interface StoredEpisode {
  first_detected_date: string;
  last_evaluated_date?: string | null;
  days_tracked?: number | null;
  below_threshold_days?: number | null;
  last_score?: number | null;
  entry_close?: number | null;
}

export interface SameDayReconciliation {
  /** This session has already been ticked once by an earlier run today. */
  alreadyToday: boolean;
  /** The episode was opened during this same session. */
  openedToday: boolean;
  /** days_tracked with today's increment removed, ready to be re-applied. */
  prevDays: number;
  /** below_threshold_days with today's increment removed. */
  prevBelow: number;
}

/**
 * Strip the current session's contribution from the stored counters so the
 * state machine can re-apply it cleanly. Idempotent: running the pass N times
 * for one session must leave the same numbers as running it once.
 */
export function reconcileSameDay(
  e: StoredEpisode,
  sessionDate: string,
  qualifyScore: number,
): SameDayReconciliation {
  const alreadyToday = e.last_evaluated_date === sessionDate;
  const openedToday = e.first_detected_date === sessionDate;

  const storedDays = e.days_tracked ?? 1;
  const prevDays = alreadyToday ? Math.max(0, storedDays - 1) : storedDays;

  const storedBelow = e.below_threshold_days ?? 0;
  const countedTodayBelow = alreadyToday && (Number(e.last_score) || 0) < qualifyScore;
  const prevBelow = countedTodayBelow ? Math.max(0, storedBelow - 1) : storedBelow;

  return { alreadyToday, openedToday, prevDays, prevBelow };
}

/**
 * Entry price for the episode. While the episode is still inside its own
 * opening session the entry is provisional (it may have been stamped from a
 * partial intraday close) and is re-read; from the next session on it is
 * immutable history, because every return, MAE and follow-through number is
 * measured off it.
 */
export function resolveEntryPrice(
  e: StoredEpisode,
  close: number,
  openedToday: boolean,
): number {
  return openedToday ? close : (Number(e.entry_close) || close);
}

/**
 * Append (or correct, on a same-session re-run) the score trend, inserting an
 * explicit null for every skipped session so the sparkline shows a gap rather
 * than stitching two distant sessions together.
 */
export function nextScoreTrend(
  base: (number | null)[],
  score: number,
  alreadyToday: boolean,
  gapSessions: number,
  cap: number,
): (number | null)[] {
  if (alreadyToday) {
    return base.length ? [...base.slice(0, -1), score] : [score];
  }
  const gaps = Array(Math.max(0, Math.min(gapSessions, cap))).fill(null) as (number | null)[];
  return [...base, ...gaps, score].slice(-cap);
}
