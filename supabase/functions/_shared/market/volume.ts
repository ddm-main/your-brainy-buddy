// Volume sanity helpers.
//
// Several feeds — broker quote snapshots above all — report the RUNNING DAY
// TOTAL traded quantity instead of the quantity traded inside a bar. Rendered
// as-is that produces the classic "staircase" volume pane, and any downstream
// aggregation (1m -> 5m buckets, OBV, relative volume, volume profile) is
// inflated on top of it.
//
// Verified against live data, a session is not cleanly one or the other: the
// same symbol/day can start with honest per-bar prints and then switch to a
// running total when the writer loses its baseline. So the repair works on
// RUNS, not whole sessions: find each long non-decreasing run whose values
// dwarf its own step size — that is a cumulative counter — and convert just
// that run back to per-bar deltas. Everything else is left untouched.

const IST_OFFSET_MS = 5.5 * 3600_000;
const SESSION_OPEN_MS = (9 * 60 + 15) * 60_000; // 09:15 IST

/** Minimum number of consecutive non-decreasing bars before we call it a counter. */
const MIN_RUN = 8;
/** How much bigger the run's values must be than its own typical step. */
const MIN_LEVEL_TO_STEP = 10;


export function sessionOpenSecFor(epochSec: number): number {
  const ms = epochSec * 1000;
  const istDayStartMs = Math.floor((ms + IST_OFFSET_MS) / 86_400_000) * 86_400_000;
  return Math.floor((istDayStartMs - IST_OFFSET_MS + SESSION_OPEN_MS) / 1000);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Maximal runs [start, end] (inclusive) of non-decreasing values. */
function nonDecreasingRuns(vols: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = 0;
  for (let i = 1; i <= vols.length; i++) {
    if (i === vols.length || vols[i] < vols[i - 1]) {
      if (i - start >= 2) runs.push([start, i - 1]);
      start = i;
    }
  }
  return runs;
}

export type VolumeRepair = {
  volumes: number[];
  /** Runs that were converted from a running total to per-bar deltas. */
  repairedRuns: number;
};

/**
 * Converts any cumulative-counter run inside a volume series back to per-bar
 * volumes. The first bar of a repaired run is capped at that run's median step
 * so the quantity traded before the counter was first observed doesn't draw one
 * absurd spike.
 */
export function repairVolumeSeries(vols: number[]): VolumeRepair {
  const clean = vols.map((v) => (Number.isFinite(v) && v > 0 ? Number(v) : 0));
  const out = [...clean];
  let repairedRuns = 0;
  for (const [start, end] of nonDecreasingRuns(clean)) {
    const len = end - start + 1;
    if (len < MIN_RUN) continue;
    const steps: number[] = [];
    for (let i = start + 1; i <= end; i++) steps.push(clean[i] - clean[i - 1]);
    const step = median(steps.filter((s) => s > 0));
    if (step <= 0) continue;
    // A genuine per-bar series that happens to drift upward has bar values of
    // roughly the same size as the difference between neighbouring bars. A
    // counter's values are orders of magnitude larger than its own steps.
    if (clean[end] / step < MIN_LEVEL_TO_STEP) continue;
    repairedRuns++;
    // A run can begin one bar BEFORE the counter does: the last honest per-bar
    // print is small, so the counter's first (huge) value still counts as
    // "non-decreasing". When the run's opening step dwarfs its own typical
    // step, that first bar belongs to the previous regime — leave it alone and
    // start the counter at the next bar.
    const jumpStart = steps[0] > 5 * step ? start + 1 : start;
    out[jumpStart] = Math.min(clean[jumpStart], step);
    for (let i = jumpStart + 1; i <= end; i++) out[i] = Math.max(0, clean[i] - clean[i - 1]);

  }
  return { volumes: out, repairedRuns };
}

/** True when the series still contains a day-cumulative counter run. */
export function looksCumulative(bars: Array<{ time: number; volume: number }>): boolean {
  if (bars.length < MIN_RUN) return false;
  const bySession = new Map<number, number[]>();
  for (const b of bars) {
    const day = sessionOpenSecFor(b.time);
    const list = bySession.get(day);
    if (list) list.push(Number(b.volume) || 0); else bySession.set(day, [Number(b.volume) || 0]);
  }
  for (const vols of bySession.values()) {
    if (repairVolumeSeries(vols).repairedRuns > 0) return true;
  }
  return false;
}

/**
 * Straight de-cumulation of a series known to be a running total (e.g. the
 * `cum_volume` column). A drop restarts the baseline; the first bar is capped
 * at the median delta.
 */
export function decumulateVolumes(vols: number[]): number[] {
  const clean = vols.map((v) => (Number.isFinite(v) && v > 0 ? Number(v) : 0));
  const deltas: number[] = [];
  for (let i = 1; i < clean.length; i++) {
    const step = clean[i] - clean[i - 1];
    deltas.push(step >= 0 ? step : clean[i]);
  }
  const med = median(deltas.filter((d) => d > 0));
  const first = med > 0 ? Math.min(clean[0], med) : clean[0];
  return [first, ...deltas];
}

/**
 * Per-session volume repair over OHLCV bars. Sessions (and stretches within a
 * session) that already carry honest per-bar volume are returned untouched.
 */
export function decumulateBars<T extends { time: number; volume: number }>(
  bars: T[],
): { bars: T[]; repairedSessions: number } {
  if (bars.length < MIN_RUN) return { bars, repairedSessions: 0 };
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const bySession = new Map<number, T[]>();
  for (const b of sorted) {
    const day = sessionOpenSecFor(b.time);
    const list = bySession.get(day);
    if (list) list.push(b); else bySession.set(day, [b]);
  }
  const out: T[] = [];
  let repairedSessions = 0;
  for (const list of bySession.values()) {
    const { volumes, repairedRuns } = repairVolumeSeries(list.map((b) => Number(b.volume) || 0));
    if (repairedRuns === 0) { out.push(...list); continue; }
    repairedSessions++;
    for (let i = 0; i < list.length; i++) out.push({ ...list[i], volume: volumes[i] });
  }
  return { bars: out.sort((a, b) => a.time - b.time), repairedSessions };
}

/**
 * Kept for callers that want a yes/no on a whole session (e.g. deciding
 * whether a stored `cum_volume` column really holds a running total).
 */
export function classifyVolumeSeries(vols: number[]): { cumulative: boolean } {
  return { cumulative: repairVolumeSeries(vols).repairedRuns > 0 };
}
