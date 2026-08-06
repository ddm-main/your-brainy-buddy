// Default visible windows and fetch depths per chart interval.
// Trimmed to the timeframes the backend actually serves without duplicates.
// Dropped: 3m/30m (dupes of neighbours), 2h/4h (no EOD pipeline coverage for
// Indian equities), 45m/3h (no INTRADAY map entry in market-candles — the
// edge fn 400s on them and the chart went blank). TV mode still accepts
// everything via tvInterval(). 1W/1M are resampled from the stored daily
// series by market-candles.
export const TIMEFRAMES = [
  { key: "1m", label: "1m", intraday: true },
  { key: "5m", label: "5m", intraday: true },
  { key: "15m", label: "15m", intraday: true },
  { key: "1h", label: "1h", intraday: true },
  { key: "1D", label: "1D", intraday: false },
  { key: "1W", label: "1W", intraday: false },
  { key: "1M", label: "1M", intraday: false },
] as const;

// Viewport ranges for non-intraday charts. These only move the visible
// window — the full series stays loaded, so panning left still reveals
// everything the provider returned.
export const CHART_RANGES = [
  { key: "1Y", label: "1Y", years: 1 },
  { key: "2Y", label: "2Y", years: 2 },
  { key: "3Y", label: "3Y", years: 3 },
  { key: "5Y", label: "5Y", years: 5 },
  { key: "ALL", label: "All", years: null },
] as const;

export type ChartRange = typeof CHART_RANGES[number]["key"];

// Default visible window per interval (industry standard: time-based, not a
// fixed bar count, so holidays/half-days don't shift the frame). History
// beyond the window stays loaded — panning left reveals it.
export type TfWindow = { hours?: number; sessions?: number; months?: number; years?: number };

export const TF_WINDOWS: Record<string, TfWindow> = {
  "1m": { hours: 24 },      // rolling full trading day (10:00 yesterday → now)
  "5m": { sessions: 4 },
  "15m": { sessions: 8 },
  "1h": { months: 1 },
  "1D": { years: 2 },
  "1W": { years: 5 },
  "1M": {},                 // all
};

// Upstream fetch window per interval — must be deeper than the default
// visible window so panning left always has data behind it. Daily grains ask
// for the full stored history so the 2Y/5Y/ALL default windows resolve.
export const TF_FETCH_RANGE: Record<string, string> = {
  "1m": "7d",
  "5m": "10d",
  "15m": "20d",
  "1h": "3mo",
  "1D": "max",
  "1W": "max",
  "1M": "max",
};


// Default range-dropdown selection per non-intraday interval.
export const DEFAULT_RANGE_BY_TF: Record<string, ChartRange> = {
  "1D": "2Y",
  "1W": "5Y",
  "1M": "ALL",
};

const IST_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
});
const barMs = (t: number | string) => (typeof t === "number" ? t * 1000 : Date.parse(String(t)));

/**
 * Bars to show by default for `tf`, measured back from the newest bar.
 * Returns null when the whole series should be shown.
 */
export function defaultVisibleBars(
  candles: Array<{ time: number | string }> | undefined,
  tf: string,
): number | null {
  if (!candles || candles.length === 0) return null;
  const w = TF_WINDOWS[tf];
  if (!w || (!w.hours && !w.sessions && !w.months && !w.years)) return null;
  const lastMs = barMs(candles[candles.length - 1].time);
  if (!Number.isFinite(lastMs)) return null;

  if (w.sessions) {
    const days: string[] = [];
    let n = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      const d = IST_DAY.format(new Date(barMs(candles[i].time)));
      if (days[days.length - 1] !== d) {
        if (days.length >= w.sessions) break;
        days.push(d);
      }
      n++;
    }
    return n > 0 ? n : null;
  }

  let cutoff: number;
  if (w.hours) cutoff = lastMs - w.hours * 3_600_000;
  else {
    const d = new Date(lastMs);
    if (w.months) d.setMonth(d.getMonth() - w.months);
    if (w.years) d.setFullYear(d.getFullYear() - w.years);
    cutoff = d.getTime();
  }
  let n = 0;
  for (let i = candles.length - 1; i >= 0 && barMs(candles[i].time) >= cutoff; i--) n++;
  return n > 0 ? n : null;
}

// Approximate bars per year for each timeframe — NSE trades ~250 sessions a
// year, ~6.25 hourly bars per session.
const BARS_PER_YEAR: Record<string, number> = {
  "1m": 250 * 375,
  "5m": 250 * 75,
  "15m": 250 * 25,
  "1h": 250 * 6.25,
  "1D": 250,
  "1W": 52,
  "1M": 12,
};

// Approximate bar counts per timeframe for a given number of years.
export function rangeToBars(range: ChartRange, tf: string): number | null {
  const years = CHART_RANGES.find((r) => r.key === range)?.years ?? null;
  if (years == null) return null;
  const perYear = BARS_PER_YEAR[tf] ?? 250;
  return Math.max(20, Math.round(years * perYear));
}

export function isIntraday(tf: string): boolean {
  return TIMEFRAMES.find((t) => t.key === tf)?.intraday ?? false;
}




