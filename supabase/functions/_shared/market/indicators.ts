// Technical-indicator math. Pure TS, zero Deno/npm imports — unit-tested via vitest.
// All series are oldest → newest. Results align with the input length; positions
// where the indicator is not yet defined are null.

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const fastE = ema(closes, fast);
  const slowE = ema(closes, slow);
  const macdLine: (number | null)[] = closes.map((_, i) =>
    fastE[i] != null && slowE[i] != null ? (fastE[i] as number) - (slowE[i] as number) : null,
  );
  // Signal = EMA of the macd line where defined
  const defined = macdLine.filter((v): v is number => v != null);
  const sigDefined = ema(defined, signalPeriod);
  const signal: (number | null)[] = new Array(closes.length).fill(null);
  let j = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] != null) {
      signal[i] = sigDefined[j] ?? null;
      j++;
    }
  }
  const hist = macdLine.map((v, i) =>
    v != null && signal[i] != null ? v - (signal[i] as number) : null,
  );
  return { macd: macdLine, signal, hist };
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

// Wilder's ATR
export function atr(candles: Candle[], period = 14): (number | null)[] {
  const tr = trueRange(candles);
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Wilder's ADX
export function adx(candles: Candle[], period = 14): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period * 2 + 1) return out;
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr = trueRange(candles);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  let smTR = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smPlus = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smMinus = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      smTR = smTR - smTR / period + tr[i];
      smPlus = smPlus - smPlus / period + plusDM[i];
      smMinus = smMinus - smMinus / period + minusDM[i];
    }
    const pDI = smTR === 0 ? 0 : (100 * smPlus) / smTR;
    const mDI = smTR === 0 ? 0 : (100 * smMinus) / smTR;
    const sum = pDI + mDI;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / sum;
  }
  let adxPrev = 0;
  let count = 0;
  for (let i = period; i < n; i++) {
    if (dx[i] == null) continue;
    count++;
    if (count < period) {
      adxPrev += dx[i] as number;
    } else if (count === period) {
      adxPrev = (adxPrev + (dx[i] as number)) / period;
      out[i] = adxPrev;
    } else {
      adxPrev = (adxPrev * (period - 1) + (dx[i] as number)) / period;
      out[i] = adxPrev;
    }
  }
  return out;
}

export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { upper: (number | null)[]; mid: (number | null)[]; lower: (number | null)[]; width: (number | null)[] } {
  const mid = sma(closes, period);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  const width: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i] as number;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - m) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    width[i] = m === 0 ? null : ((upper[i] as number) - (lower[i] as number)) / m;
  }
  return { upper, mid, lower, width };
}

export function rollingHighLow(
  candles: Candle[],
  period = 252,
): { high: number | null; low: number | null } {
  if (candles.length === 0) return { high: null, low: null };
  const window = candles.slice(-period);
  let high = -Infinity;
  let low = Infinity;
  for (const c of window) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low };
}

export function relVolume(volumes: number[], avgPeriod = 20): number | null {
  if (volumes.length < avgPeriod + 1) return null;
  const today = volumes[volumes.length - 1];
  const prior = volumes.slice(-avgPeriod - 1, -1);
  const avg = prior.reduce((a, b) => a + b, 0) / avgPeriod;
  return avg === 0 ? null : today / avg;
}

export function medianOf(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Relative volume against the MEDIAN of the prior N sessions. The mean is
// dragged upward by a single climactic day, which then makes the next genuine
// expansion look ordinary; the median is stable against that.
export function relVolumeMedian(volumes: number[], period = 30): number | null {
  if (volumes.length < period + 1) return null;
  const med = medianOf(volumes.slice(-period - 1, -1));
  return med > 0 ? volumes[volumes.length - 1] / med : null;
}

// True if the last `count` swing lows are strictly ascending.
export function higherLows(lows: number[], lookback = 40, count = 3): boolean {
  const window = lows.slice(-lookback);
  if (window.length < 7) return false;
  const swings: number[] = [];
  for (let i = 2; i < window.length - 2; i++) {
    if (
      window[i] < window[i - 1] &&
      window[i] < window[i - 2] &&
      window[i] < window[i + 1] &&
      window[i] < window[i + 2]
    ) {
      swings.push(window[i]);
    }
  }
  if (swings.length < count) return false;
  const last = swings.slice(-count);
  for (let i = 1; i < last.length; i++) if (last[i] <= last[i - 1]) return false;
  return true;
}

// Detect swing pivots (fractals) with configurable side-strength. Right-side
// window is allowed to shrink at the tail so the most recent swing isn't
// silently dropped (the previous implementation ignored the last two bars).
//
// A pivot found with fewer than `strength` bars to its right is flagged
// `provisional`: it has not been confirmed by subsequent price action and can
// still be taken out tomorrow. At the very last bar `rightBars` is 0, so
// today's own high would otherwise register as a fully confirmed level — and
// then be read as a level price has "cleared", which is circular. Consumers
// that decide what price broke through must drop provisional pivots.
type Pivot = { price: number; index: number; volume: number; provisional: boolean };
function findPivots(
  window: Candle[],
  side: "high" | "low",
  strength: number,
): Pivot[] {
  const out: Pivot[] = [];
  for (let i = strength; i < window.length; i++) {
    const c = window[i];
    const val = side === "high" ? c.high : c.low;
    let ok = true;
    // left side: strict
    for (let k = 1; k <= strength; k++) {
      const other = side === "high" ? window[i - k].high : window[i - k].low;
      if (side === "high" ? other >= val : other <= val) { ok = false; break; }
    }
    if (!ok) continue;
    // right side: shrink at tail, allow equality only when we have < strength bars
    const rightBars = Math.min(strength, window.length - 1 - i);
    for (let k = 1; k <= rightBars; k++) {
      const other = side === "high" ? window[i + k].high : window[i + k].low;
      if (side === "high" ? other >= val : other <= val) { ok = false; break; }
    }
    if (!ok) continue;
    out.push({ price: val, index: i, volume: c.volume, provisional: rightBars < strength });
  }
  return out;
}


// Cluster pivots by ATR% band, weight by touches + recency + volume.
//
// `touchQuality` is the volume-weighted touch count: a ceiling rejected on
// heavy volume is a real supply zone, while three low-volume touches are not.
// Each touch counts as its volume relative to the window's median volume,
// capped at 2 so one climactic bar can't manufacture a "strong" level.
type Cluster = { price: number; touches: number; touchQuality: number; strength: number };
function clusterPivots(pivots: Pivot[], bandPct: number, windowLen: number, medianVolume = 0): Cluster[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Cluster[] = [];
  let bucket: Pivot[] = [];
  const flush = () => {
    if (!bucket.length) return;
    const vwPrice = bucket.reduce((s, p) => s + p.price * Math.max(1, p.volume), 0) /
                    bucket.reduce((s, p) => s + Math.max(1, p.volume), 0);
    // recency: newer pivots weight more (0..1 across window)
    const recency = bucket.reduce((s, p) => s + p.index / Math.max(1, windowLen - 1), 0);
    const touchQuality = medianVolume > 0
      ? bucket.reduce((s, p) => s + Math.min(2, Math.max(0.25, p.volume / medianVolume)), 0)
      : bucket.length;
    clusters.push({
      price: vwPrice,
      touches: bucket.length,
      touchQuality: Math.round(touchQuality * 100) / 100,
      // Strength ranks zones against each other: volume-weighted touches beat
      // a raw count of thin pokes at the same price.
      strength: touchQuality + recency,
    });
    bucket = [];
  };
  for (const p of sorted) {
    if (!bucket.length) { bucket.push(p); continue; }
    const ref = bucket[bucket.length - 1].price;
    if (Math.abs(p.price - ref) / ref <= bandPct) bucket.push(p);
    else { flush(); bucket.push(p); }
  }
  flush();
  return clusters;
}

// Cluster swing highs/lows into support & resistance zones weighted by
// touches, recency, and volume. Returns the strongest zone above/below the
// last close, with ATR-scaled tolerance so a slightly-cleared level still
// counts. Falls back to lookback high/low so ATH/ATL stocks still get levels.
export function supportResistance(
  candles: Candle[],
  lookback = 250,
): {
  support: number | null;
  resistance: number | null;
  supportTouches: number;
  resistanceTouches: number;
  supportFallback: boolean;
  resistanceFallback: boolean;
  // Strongest clustered level strictly ABOVE the last close. `resistance`
  // tolerates a level up to 0.25×ATR below price (so a just-cleared ceiling
  // still shows), which made "near resistance" impossible to satisfy whenever
  // that tolerance kicked in. This field is the honest ceiling for that test.
  resistanceAbove: number | null;
} {
  const empty = {
    support: null, resistance: null,
    supportTouches: 0, resistanceTouches: 0,
    supportFallback: false, resistanceFallback: false,
    resistanceAbove: null,
  };
  const window = candles.slice(-lookback);
  if (window.length < 20) return empty;
  const lastClose = window[window.length - 1].close;
  const a = atr(window, 14);
  const atrV = lastDefined(a) ?? (lastClose * 0.02);
  const band = Math.max(0.003, (0.5 * atrV) / lastClose); // cluster band, min 0.3%
  const tol = 0.25 * atrV;                                 // "still counts" tolerance

  const strength = 3;
  const hiPivots = findPivots(window, "high", strength);
  const loPivots = findPivots(window, "low", strength);
  const medVol = medianOf(window.map((c) => c.volume));
  const hiClusters = clusterPivots(hiPivots, band, window.length, medVol);
  const loClusters = clusterPivots(loPivots, band, window.length, medVol);

  const aboveHi = hiClusters
    .filter((c) => c.price >= lastClose - tol)
    .sort((a, b) => b.strength - a.strength || a.price - b.price)[0];
  const belowLo = loClusters
    .filter((c) => c.price <= lastClose + tol)
    .sort((a, b) => b.strength - a.strength || b.price - a.price)[0];

  let resistance: number | null = aboveHi?.price ?? null;
  let resistanceTouches = aboveHi?.touches ?? 0;
  let resistanceFallback = false;
  if (resistance == null) {
    const hi = Math.max(...window.map((c) => c.high));
    resistance = hi;
    resistanceFallback = true;
  }
  let support: number | null = belowLo?.price ?? null;
  let supportTouches = belowLo?.touches ?? 0;
  let supportFallback = false;
  if (support == null) {
    const lo = Math.min(...window.map((c) => c.low));
    support = lo;
    supportFallback = true;
  }
  const strictAbove = hiClusters
    .filter((c) => c.price > lastClose)
    .sort((a, b) => b.strength - a.strength || a.price - b.price)[0];
  const winHigh = Math.max(...window.map((c) => c.high));
  const resistanceAbove = strictAbove?.price ?? (winHigh > lastClose ? winHigh : null);
  return {
    support, resistance, supportTouches, resistanceTouches,
    supportFallback, resistanceFallback, resistanceAbove,
  };
}

// Touch count / volume-weighted touch quality of an arbitrary price level:
// how many clustered swing highs sit within the ATR-scaled band of it. Used so
// a breakout over the rolling-20 high can be graded on the SAME level-quality
// scale as one over a cluster pivot, instead of being flatly discounted.
export function levelTouchQuality(
  candles: Candle[],
  level: number | null,
  lookback = 250,
): { touches: number; touchQuality: number } {
  const none = { touches: 0, touchQuality: 0 };
  if (level == null || !(level > 0)) return none;
  const window = candles.slice(-lookback);
  if (window.length < 20) return none;
  const lastClose = window[window.length - 1].close;
  const atrV = lastDefined(atr(window, 14)) ?? lastClose * 0.02;
  const band = Math.max(0.003, (0.5 * atrV) / lastClose);
  const clusters = clusterPivots(
    findPivots(window, "high", 3), band, window.length, medianOf(window.map((c) => c.volume)),
  );
  let touches = 0, touchQuality = 0;
  for (const c of clusters) {
    if (Math.abs(c.price - level) / level <= band) { touches += c.touches; touchQuality += c.touchQuality; }
  }
  return { touches, touchQuality: Math.round(touchQuality * 100) / 100 };
}

// The breakout pivot proper: the strongest clustered swing-high level that
// price has already cleared (at or below the last close), rather than a blind
// rolling-N high. A level touched 3+ times is a real base ceiling; a rolling
// high can be a single spike bar. Returns null when no cleared cluster exists
// within `maxAtrsBelow` ATRs of price (i.e. nothing meaningful was broken).
export function resistancePivot(
  candles: Candle[],
  lookback = 250,
  maxAtrsBelow = 6,
): { level: number | null; touches: number; touchQuality: number; atrsAbove: number | null } {
  const window = candles.slice(-lookback);
  const none = { level: null, touches: 0, touchQuality: 0, atrsAbove: null };
  if (window.length < 20) return none;
  const lastClose = window[window.length - 1].close;
  const atrV = lastDefined(atr(window, 14)) ?? lastClose * 0.02;
  if (!(atrV > 0)) return none;
  const band = Math.max(0.003, (0.5 * atrV) / lastClose);
  // Provisional pivots are excluded here: an unconfirmed swing high at the tail
  // (often today's own high) must not become "the level price cleared".
  const clusters = clusterPivots(
    findPivots(window, "high", 3).filter((p) => !p.provisional),
    band, window.length, medianOf(window.map((c) => c.volume)),
  );

  const cleared = clusters
    .filter((c) => c.price <= lastClose && (lastClose - c.price) / atrV <= maxAtrsBelow)
    // prefer the strongest (touches + recency); tie-break to the higher level
    .sort((a, b) => b.strength - a.strength || b.price - a.price)[0];
  if (!cleared) return none;
  return {
    level: cleared.price,
    touches: cleared.touches,
    touchQuality: cleared.touchQuality,
    atrsAbove: (lastClose - cleared.price) / atrV,
  };
}

// Volume dry-up: mean volume of the last 5 completed-plus-current sessions
// relative to the 20-session mean. < 1 means supply is drying up inside the
// base — a classic pre-breakout tell. Null when history is too short.
export function volumeDryUpRatio(volumes: number[], shortN = 5, longN = 20): number | null {
  if (volumes.length < longN) return null;
  const shortAvg = volumes.slice(-shortN).reduce((a, b) => a + b, 0) / shortN;
  const longAvg = volumes.slice(-longN).reduce((a, b) => a + b, 0) / longN;
  if (!(longAvg > 0)) return null;
  return shortAvg / longAvg;
}

// Same ratio, measured on the window ENDING at `endIdx` instead of today.
// Dry-up is a property of the base, not of the breakout bar: measured through
// today, the expansion being scored inflates the 5D average and collapses the
// dry-up factor exactly when the setup is at its best.
export function volumeDryUpRatioAt(
  volumes: number[], endIdx: number, shortN = 5, longN = 20,
): number | null {
  const end = Math.min(endIdx, volumes.length - 1);
  if (end + 1 < longN) return null;
  const win = volumes.slice(0, end + 1);
  return volumeDryUpRatio(win, shortN, longN);
}

// Sessions since `fast` crossed above `slow` and stayed there. 0 = crossed
// today; -1 = fast is currently BELOW slow (a real "no cross", which
// freshCross() scores as 0); null = not enough data / the cross happened
// before the lookback, which the scorer must treat as unknown.
export function emaCrossFreshDays(
  fast: (number | null)[], slow: (number | null)[], lookback = 60,
): number | null {
  const last = Math.min(fast.length, slow.length) - 1;
  if (last < 1) return null;
  const at = (i: number): number | null => {
    const f = fast[i], s = slow[i];
    if (f == null || s == null) return null;
    return f > s ? 1 : 0;
  };
  const now = at(last);
  if (now == null) return null;
  if (now === 0) return -1;
  for (let i = last; i >= Math.max(1, last - lookback); i--) {
    const cur = at(i), prev = at(i - 1);
    if (cur == null) return null;
    if (cur === 1 && prev === 0) return last - i;
  }
  // Above, but the cross is older than the lookback: that is a known-stale
  // cross (scores 0 through the 25-session decay), not missing data.
  return lookback;
}



function lastDefined(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) return series[i];
  return null;
}

// On-Balance Volume series (aligned to candles).
export function obv(candles: Candle[]): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const dir = candles[i].close > candles[i - 1].close ? 1 : candles[i].close < candles[i - 1].close ? -1 : 0;
    out[i] = out[i - 1] + dir * candles[i].volume;
  }
  return out;
}

// Normalized least-squares slope of the last `period` values of a series.
// Returned in "per-session-relative-to-mean" units so it's comparable across symbols.
export function normalizedSlope(series: number[], period = 20): number | null {
  if (series.length < period) return null;
  const y = series.slice(-period);
  const n = y.length;
  const xMean = (n - 1) / 2;
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (y[i] - yMean);
    den += (i - xMean) ** 2;
  }
  if (den === 0) return 0;
  const slope = num / den;
  const scale = Math.max(1, Math.abs(yMean));
  return slope / scale;
}

// Rolling max of highs over last `period` sessions, excluding today.
export function rollingHighExclToday(candles: Candle[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  const window = candles.slice(-period - 1, -1);
  let h = -Infinity;
  for (const c of window) if (c.high > h) h = c.high;
  return Number.isFinite(h) ? h : null;
}

// Explicit three-state breakout read. The old single "freshness days or null"
// answer collapsed three very different situations into null — no breakout at
// all, and a breakout that has since failed back under its level — which meant
// the scorer renormalised the factor away instead of scoring it 0, and the
// failed-breakout penalty could never fire.
export type BreakoutStateKind = "fresh" | "failed" | "none";
export interface BreakoutStateRead {
  state: BreakoutStateKind;
  // Sessions since the clearing bar (0 = today). Null when state is "none".
  days: number | null;
  // The level that was cleared, for the failure-depth penalty.
  level: number | null;
}
export function breakoutState(candles: Candle[], period = 20, lookback = 10): BreakoutStateRead {
  const none: BreakoutStateRead = { state: "none", days: null, level: null };
  if (candles.length < period + 2) return none;
  const lastClose = candles[candles.length - 1].close;
  for (let k = 0; k < lookback && k < candles.length - period - 1; k++) {
    const i = candles.length - 1 - k;
    const win = candles.slice(i - period, i);
    let h = -Infinity;
    for (const c of win) if (c.high > h) h = c.high;
    if (!(candles[i].close > h)) continue;
    // Only count the FIRST bar that cleared the level: if the previous session
    // already closed above its own shifted high, this is a continuation bar and
    // the real breakout is older. Applied uniformly — the old code skipped this
    // check on the last iteration, which could report a stale breakout as 9d.
    if (i - period - 1 >= 0) {
      const prevWin = candles.slice(i - period - 1, i - 1);
      let ph = -Infinity;
      for (const c of prevWin) if (c.high > ph) ph = c.high;
      if (candles[i - 1].close > ph) continue;
    }
    return { state: lastClose > h ? "fresh" : "failed", days: k, level: h };
  }
  return none;
}

// Backwards-compatible wrapper: sessions since the price first cleared the
// rolling-N high, and null when there is no *live* breakout.
export function breakoutFreshnessDays(candles: Candle[], period = 20, lookback = 10): number | null {
  const r = breakoutState(candles, period, lookback);
  return r.state === "fresh" ? r.days : null;
}

// Where today's close lies in its daily range, 0..100. 100 = at high, 0 = at low.
export function closeInRangePct(c: Candle): number | null {
  const rng = c.high - c.low;
  if (!Number.isFinite(rng) || rng <= 0) return null;
  return ((c.close - c.low) / rng) * 100;
}

// Base metrics: measure `window` sessions as a consolidation base, ending at
// `endIdx` (inclusive). `endIdx` matters: measuring through the breakout bar
// let the thrust itself inflate SD and hi−lo depth and push price out of the
// duration band, so tightness/depth/duration all collapsed at exactly the
// moment the trigger fired. Callers pass the last bar BELOW the pivot.
export function baseMetrics(
  candles: Candle[],
  window = 30,
  endIdx: number = candles.length - 1,
): {
  tightness: number | null;
  depthPct: number | null;
  durationDays: number | null;
} {
  const nothing = { tightness: null, depthPct: null, durationDays: null };
  const end = Math.min(endIdx, candles.length - 1);
  if (end + 1 < window) return nothing;
  const slice = candles.slice(end + 1 - window, end + 1);
  const closes = slice.map((c) => c.close);
  const n = closes.length;
  const mean = closes.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return nothing;
  // Detrended tightness: SD of the residuals around the least-squares line, not
  // around the flat mean — otherwise a clean rising base reads as "loose" purely
  // because it trends.
  const xMean = (n - 1) / 2;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xMean) * (closes[i] - mean); den += (i - xMean) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  let resVar = 0;
  for (let i = 0; i < n; i++) {
    const fit = mean + slope * (i - xMean);
    resVar += (closes[i] - fit) ** 2;
  }
  const tightness = Math.sqrt(resVar / n) / mean; // lower = tighter
  let hi = -Infinity, lo = Infinity;
  for (const c of slice) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  const depthPct = hi > 0 ? ((hi - lo) / hi) * 100 : null;
  // Duration = trailing sessions (up to endIdx) whose close stayed within
  // ±(depthPct*0.75)% of the base mean.
  let duration = 0;
  const band = Math.abs(depthPct ?? 0) * 0.75;
  for (let i = end; i >= 0; i--) {
    if (Math.abs((candles[i].close - mean) / mean) * 100 <= band) duration++;
    else break;
  }
  // A real 0 means "no base at all" (price is outside the band) — it must stay
  // 0, not fall back to `window` and score as a mature base.
  return { tightness, depthPct, durationDays: duration };
}

// Index of the last bar that closed at/below `level` — where the base that
// price is breaking out of actually ends. Falls back to the final bar when
// price never traded under the level inside `maxBack`.
export function baseEndIndex(candles: Candle[], level: number | null, maxBack = 15): number {
  const last = candles.length - 1;
  if (level == null || !(level > 0)) return last;
  for (let i = last; i >= Math.max(0, last - maxBack); i--) {
    if (candles[i].close <= level) return i;
  }
  return Math.max(0, last - maxBack);
}


// Resample daily candles into ISO-week (Mon-start) bars. Pure aggregation
// over data already fetched/persisted elsewhere — no new data source.
// Assumes `candles` is sorted oldest→newest (the convention this whole file
// uses), one call per `time` (unix seconds, UTC).
function isoWeekKey(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const dow = (d.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - dow);
  return monday.toISOString().slice(0, 10);
}

export function resampleWeekly(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  let curKey: string | null = null;
  let bar: Candle | null = null;
  for (const c of candles) {
    const key = isoWeekKey(c.time);
    if (key !== curKey) {
      if (bar) out.push(bar);
      bar = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      curKey = key;
    } else if (bar) {
      if (c.high > bar.high) bar.high = c.high;
      if (c.low < bar.low) bar.low = c.low;
      bar.close = c.close;
      bar.volume += c.volume;
    }
  }
  if (bar) out.push(bar);
  return out;
}

export interface WeeklySnapshot {
  closeW: number | null;
  ema20W: number | null;
  rsi14W: number | null;
  aboveEma20W: boolean;
  // aboveEma20W AND rsi14W > 50 — the single "is the weekly chart
  // constructive" flag consumed by swingScore.
  trendUpW: boolean;
  higherLowsW: boolean;
  barsW: number;
}

// Weekly trend confirmation, resampled from whatever daily candles the
// caller already has in memory (market-pipeline-eod fetches 2y daily —
// plenty for ~25+ weekly bars). No new persistence, no new provider calls.
export function computeWeeklySnapshot(dailyCandles: Candle[]): WeeklySnapshot | null {
  const weekly = resampleWeekly(dailyCandles);
  // ~25 weekly bars (~6 months) is the minimum for a meaningful EMA20/RSI14 read.
  if (weekly.length < 25) return null;
  const closes = weekly.map((c) => c.close);
  const lows = weekly.map((c) => c.low);
  const e20 = ema(closes, 20);
  const r14 = rsi(closes, 14);
  const closeW = closes[closes.length - 1];
  const ema20W = lastDefined(e20);
  const rsi14W = lastDefined(r14);
  const aboveEma20W = ema20W != null && closeW > ema20W;
  return {
    closeW,
    ema20W,
    rsi14W,
    aboveEma20W,
    trendUpW: aboveEma20W && rsi14W != null && rsi14W > 50,
    higherLowsW: higherLows(lows, weekly.length, 3),
    barsW: weekly.length,
  };
}

export interface IndicatorSnapshot {
  close: number;
  changePct: number | null;
  volume: number;
  volAvg20: number | null;
  volAvg30: number | null;
  relVolume: number | null;
  ema20: number | null;
  ema50: number | null;
  ema100: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  adx14: number | null;
  atr14: number | null;
  atrPct: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbWidth: number | null;
  bbSqueeze: boolean;
  atrContracting: boolean;
  high52w: number | null;
  low52w: number | null;
  pctFrom52wHigh: number | null;
  aboveEma200: boolean;
  emaAligned: boolean;
  higherLows: boolean;
  support: number | null;
  resistance: number | null;
  nearResistance: boolean;
  supportTouches?: number;
  resistanceTouches?: number;
  supportFallback?: boolean;
  resistanceFallback?: boolean;
  // null = not enough histogram history to judge (never "not rising").
  macdHistRising: boolean | null;
  // Rolling N-day highs (scoring v2 breakout trigger). Optional: pipelines that
  // haven't been updated still work — the trigger falls back to pctFrom52wHigh.
  rollingHigh20?: number | null;
  rollingHigh55?: number | null;
  obvSlope20?: number | null;
  // v2 scoring inputs. All optional — scoring degrades gracefully when null.
  baseTightness?: number | null;      // stddev/mean of closes over base window, lower = tighter
  baseDepthPct?: number | null;       // (high−low)/high over base, % (lower = shallower/healthier)
  baseDurationDays?: number | null;   // sessions in current base
  rsPercentile?: number | null;       // 0..100 vs universe over 55 sessions
  closeInRangePct?: number | null;    // 0..100 — where today closed within its daily range
  breakoutFreshnessDays?: number | null; // sessions since 20d high was first cleared; 0 = today
  // Explicit breakout state: "fresh" (still above the level it cleared),
  // "failed" (cleared it, then fell back inside) or "none". Distinguishes a
  // real 0 from missing data for the freshness factor.
  breakoutStateKind?: BreakoutStateKind | null;
  // Sessions since the clearing bar, kept for BOTH "fresh" and "failed".
  // breakoutFreshnessDays is deliberately fresh-only (it feeds a decay factor
  // that must not pay out on a dead breakout), which left the failed-breakout
  // penalty with no way to tell yesterday's failure from one three months old.
  breakoutStateDays?: number | null;
  breakoutLevelCleared?: number | null;

  pivotLevel?: number | null;         // strongest cleared swing-high cluster (real base ceiling)
  pivotTouches?: number | null;       // how many swing highs formed that cluster
  // Volume-weighted touch count for that cluster: heavy-volume rejections
  // count for more than thin pokes at the same price.
  pivotTouchQuality?: number | null;
  // Same touch grading for the rolling-20 high, so a genuine new-high breakout
  // is scored on level quality rather than flatly discounted.
  rollingHigh20Touches?: number | null;
  rollingHigh20TouchQuality?: number | null;
  // Strongest clustered level strictly above the close (see supportResistance).
  resistanceAbove?: number | null;
  // Rel volume vs the MEDIAN of the prior 30 sessions (spike-resistant).
  relVolumeMedian30?: number | null;
  // Sessions of price history behind this snapshot — below ~120 the chart is
  // not readable and the scorer refuses to emit a number.
  barsAvailable?: number | null;
  volDryUpRatio?: number | null;      // 5D avg volume / 20D avg volume; <1 = drying up
  // Same ratio measured on the base window (ending at the last pre-breakout
  // bar) — this is the one the v4 volume bucket scores.
  volDryUpRatioBase?: number | null;
  // Sessions since the EMA crossed up: 0 = today, -1 = currently below (real
  // 0), null = unknown. Feeds the setups bucket's two cross factors.
  emaCross2050FreshDays?: number | null;
  emaCross50200FreshDays?: number | null;

  // series for chart overlays (aligned to candles)
  ema20Series: (number | null)[];
  ema50Series: (number | null)[];
  ema200Series: (number | null)[];
}

// Compute everything the scoring engine + Analysis page needs, in one pass.
export function computeSnapshot(candles: Candle[]): IndicatorSnapshot | null {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e100 = ema(closes, 100);
  const e200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const a = atr(candles, 14);
  const ax = adx(candles, 14);
  const bb = bollinger(closes, 20, 2);
  const hl = rollingHighLow(candles, 252);

  const close = last.close;
  const ema20v = lastDefined(e20);
  const ema50v = lastDefined(e50);
  const ema100v = lastDefined(e100);
  const ema200v = lastDefined(e200);
  const atrV = lastDefined(a);

  const volAvg20 =
    volumes.length >= 21
      ? volumes.slice(-21, -1).reduce((x, y) => x + y, 0) / 20
      : null;
  // Average of the 30 completed sessions before today. The current session is
  // deliberately excluded: "today's volume > 30D average" must not dilute its
  // own comparison baseline.
  const volAvg30 = volumes.length >= 31
    ? volumes.slice(-31, -1).reduce((sum, value) => sum + value, 0) / 30
    : null;

  // BB squeeze: current width in the bottom 20% of the last 120 sessions' widths
  const widths = bb.width.slice(-120).filter((w): w is number => w != null);
  const curWidth = lastDefined(bb.width);
  let squeeze = false;
  if (curWidth != null && widths.length >= 30) {
    const sorted = [...widths].sort((x, y) => x - y);
    squeeze = curWidth <= sorted[Math.floor(sorted.length * 0.2)];
  }

  // ATR contraction: current ATR% below its 60-session average
  const atrSeries = a.slice(-60).filter((v): v is number => v != null);
  const atrAvg = atrSeries.length ? atrSeries.reduce((x, y) => x + y, 0) / atrSeries.length : null;
  const atrContracting = atrV != null && atrAvg != null && atrV < atrAvg * 0.85;

  const sr = supportResistance(candles, 250);
  // ATR-scaled "near resistance": within 0.5×ATR% of the level (min 1%).
  const nearBand = atrV != null && close ? Math.max(0.01, (0.5 * atrV) / close) : 0.03;
  // Measured against the ceiling strictly ABOVE the close: `sr.resistance`
  // tolerates a level up to 0.25×ATR under price, and whenever that tolerance
  // applied this flag could never be true.
  const nearLevel = sr.resistanceAbove ?? sr.resistance;
  const nearRes =
    nearLevel != null && close >= nearLevel * (1 - nearBand) && close < nearLevel;

  const macdHistSeries = m.hist.filter((v): v is number => v != null);
  // null when there simply isn't enough histogram history to judge — the
  // scorer must not read "we can't tell" as "not rising" and dock the factor.
  const macdHistRising: boolean | null =
    macdHistSeries.length < 3
      ? null
      : macdHistSeries[macdHistSeries.length - 1] > macdHistSeries[macdHistSeries.length - 2] &&
        macdHistSeries[macdHistSeries.length - 2] > macdHistSeries[macdHistSeries.length - 3];

  // v2 scoring inputs
  const obvSeries = obv(candles);
  const obvSlope20 = normalizedSlope(obvSeries, 20);
  const rH20 = rollingHighExclToday(candles, 20);
  const rH55 = rollingHighExclToday(candles, 55);
  const cir = closeInRangePct(last);
  const pivot = resistancePivot(candles, 250);
  // The *trigger* level is a different question from "what is this base's
  // ceiling": an episode's entry reference must be a level price has only just
  // cleared. resistancePivot accepts anything up to 6 ATRs under the close, so
  // using it as a trigger produced levels 30% below price (and, downstream, a
  // day-1 "return" of +40% on a name that had not moved).
  const triggerPivot = resistancePivot(candles, 250, TRIGGER_MAX_ATRS);
  const triggerLevel = (() => {
    if (triggerPivot.level != null) return triggerPivot.level;
    const atrV2 = atrV;
    const rh = rollingHighExclToday(candles, 20);
    if (rh == null || atrV == null || !(atrV > 0)) return null;
    // A fresh new-high breakout has no cleared cluster — the rolling high is
    // the level, but only while price is still near it.
    const atrsAbove = (close - rh) / atrV;
    return atrsAbove >= 0 && atrsAbove <= TRIGGER_MAX_ATRS ? rh : null;
  })();

  const bkState = breakoutState(candles, 20, 10);
  const freshness = bkState.state === "fresh" ? bkState.days : null;
  // Measure the base up to the last bar that was still under the pivot, so the
  // breakout thrust doesn't destroy the very base quality it broke out of.
  const pivotForBase = Math.max(pivot.level ?? -Infinity, rH20 ?? -Infinity);
  const base = baseMetrics(
    candles, 30,
    baseEndIndex(candles, Number.isFinite(pivotForBase) ? pivotForBase : null, 15),
  );
  const rh20Q = levelTouchQuality(candles, rH20, 250);
  const dryUp = volumeDryUpRatio(volumes, 5, 20);
  // Base-window dry-up (see volumeDryUpRatioAt) plus the two EMA-cross ages.
  const baseEnd = baseEndIndex(candles, Number.isFinite(pivotForBase) ? pivotForBase : null, 15);
  const dryUpBase = volumeDryUpRatioAt(volumes, baseEnd, 5, 20);
  const cross2050 = emaCrossFreshDays(e20, e50, 60);
  const cross50200 = emaCrossFreshDays(e50, e200, 60);


  return {
    close,
    changePct: prev.close ? ((close - prev.close) / prev.close) * 100 : null,
    volume: last.volume,
    volAvg20,
    volAvg30,
    relVolume: relVolume(volumes, 20),
    ema20: ema20v,
    ema50: ema50v,
    ema100: ema100v,
    ema200: ema200v,
    rsi14: lastDefined(r),
    macd: lastDefined(m.macd),
    macdSignal: lastDefined(m.signal),
    macdHist: lastDefined(m.hist),
    adx14: lastDefined(ax),
    atr14: atrV,
    atrPct: atrV != null && close ? (atrV / close) * 100 : null,
    bbUpper: lastDefined(bb.upper),
    bbLower: lastDefined(bb.lower),
    bbWidth: curWidth,
    bbSqueeze: squeeze,
    atrContracting,
    high52w: hl.high,
    low52w: hl.low,
    pctFrom52wHigh: hl.high ? ((close - hl.high) / hl.high) * 100 : null,
    aboveEma200: ema200v != null && close > ema200v,
    emaAligned:
      ema20v != null && ema50v != null && ema200v != null && ema20v > ema50v && ema50v > ema200v,
    higherLows: higherLows(lows),
    support: sr.support,
    resistance: sr.resistance,
    nearResistance: nearRes,
    supportTouches: sr.supportTouches,
    resistanceTouches: sr.resistanceTouches,
    supportFallback: sr.supportFallback,
    resistanceFallback: sr.resistanceFallback,
    macdHistRising,
    rollingHigh20: rH20,
    rollingHigh55: rH55,
    obvSlope20,
    baseTightness: base.tightness,
    baseDepthPct: base.depthPct,
    baseDurationDays: base.durationDays,
    closeInRangePct: cir,
    breakoutFreshnessDays: freshness,
    breakoutStateKind: bkState.state,
    breakoutStateDays: bkState.days,

    breakoutLevelCleared: bkState.level,
    pivotLevel: pivot.level,
    pivotTouches: pivot.touches,
    pivotTouchQuality: pivot.touchQuality,
    rollingHigh20Touches: rh20Q.touches,
    rollingHigh20TouchQuality: rh20Q.touchQuality,
    resistanceAbove: sr.resistanceAbove,
    relVolumeMedian30: relVolumeMedian(volumes, 30),
    barsAvailable: candles.length,
    volDryUpRatio: dryUp,
    volDryUpRatioBase: dryUpBase,
    emaCross2050FreshDays: cross2050,
    emaCross50200FreshDays: cross50200,

    ema20Series: e20,
    ema50Series: e50,
    ema200Series: e200,
  };
}
