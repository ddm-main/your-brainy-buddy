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
type Pivot = { price: number; index: number; volume: number };
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
    out.push({ price: val, index: i, volume: c.volume });
  }
  return out;
}

// Cluster pivots by ATR% band, weight by touches + recency + volume.
type Cluster = { price: number; touches: number; strength: number };
function clusterPivots(pivots: Pivot[], bandPct: number, windowLen: number): Cluster[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Cluster[] = [];
  let bucket: Pivot[] = [];
  const flush = () => {
    if (!bucket.length) return;
    const vwPrice = bucket.reduce((s, p) => s + p.price * Math.max(1, p.volume), 0) /
                    bucket.reduce((s, p) => s + Math.max(1, p.volume), 0);
    // recency: newer pivots weight more (0..1 across window)
    const recency = bucket.reduce((s, p) => s + p.index / Math.max(1, windowLen - 1), 0);
    clusters.push({ price: vwPrice, touches: bucket.length, strength: bucket.length + recency });
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
} {
  const empty = {
    support: null, resistance: null,
    supportTouches: 0, resistanceTouches: 0,
    supportFallback: false, resistanceFallback: false,
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
  const hiClusters = clusterPivots(hiPivots, band, window.length);
  const loClusters = clusterPivots(loPivots, band, window.length);

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
  return { support, resistance, supportTouches, resistanceTouches, supportFallback, resistanceFallback };
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

// Sessions since the price first cleared the rolling-N high. 0 = broke out today.
// Null when no breakout in the last `lookback` sessions.
export function breakoutFreshnessDays(candles: Candle[], period = 20, lookback = 10): number | null {
  if (candles.length < period + 2) return null;
  for (let k = 0; k < lookback && k < candles.length - period - 1; k++) {
    const i = candles.length - 1 - k;
    const win = candles.slice(i - period, i);
    let h = -Infinity;
    for (const c of win) if (c.high > h) h = c.high;
    if (candles[i].close > h) {
      // Check that the previous session did NOT close above the same-shifted high.
      if (k === lookback - 1) return k;
      const prevWin = candles.slice(i - period - 1, i - 1);
      let ph = -Infinity;
      for (const c of prevWin) if (c.high > ph) ph = c.high;
      if (candles[i - 1].close <= ph) return k;
    }
  }
  return null;
}

// Where today's close lies in its daily range, 0..100. 100 = at high, 0 = at low.
export function closeInRangePct(c: Candle): number | null {
  const rng = c.high - c.low;
  if (!Number.isFinite(rng) || rng <= 0) return null;
  return ((c.close - c.low) / rng) * 100;
}

// Base metrics: measure the last `window` sessions as a consolidation base.
export function baseMetrics(candles: Candle[], window = 30): {
  tightness: number | null;
  depthPct: number | null;
  durationDays: number | null;
} {
  if (candles.length < window) return { tightness: null, depthPct: null, durationDays: null };
  const slice = candles.slice(-window);
  const closes = slice.map((c) => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  if (mean === 0) return { tightness: null, depthPct: null, durationDays: window };
  const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length;
  const sd = Math.sqrt(variance);
  const tightness = sd / mean; // lower = tighter
  let hi = -Infinity, lo = Infinity;
  for (const c of slice) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  const depthPct = hi > 0 ? ((hi - lo) / hi) * 100 : null;
  // Duration = trailing sessions where close stayed within ±(depthPct*0.75)% of mean.
  let duration = 0;
  const band = Math.abs(depthPct ?? 0) * 0.75;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (Math.abs((candles[i].close - mean) / mean) * 100 <= band) duration++;
    else break;
  }
  return { tightness, depthPct, durationDays: duration || window };
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
  macdHistRising: boolean;
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
  const nearRes =
    sr.resistance != null && close >= sr.resistance * (1 - nearBand) && close < sr.resistance;

  const macdHistSeries = m.hist.filter((v): v is number => v != null);
  const macdHistRising =
    macdHistSeries.length >= 3 &&
    macdHistSeries[macdHistSeries.length - 1] > macdHistSeries[macdHistSeries.length - 2] &&
    macdHistSeries[macdHistSeries.length - 2] > macdHistSeries[macdHistSeries.length - 3];

  // v2 scoring inputs
  const obvSeries = obv(candles);
  const obvSlope20 = normalizedSlope(obvSeries, 20);
  const rH20 = rollingHighExclToday(candles, 20);
  const rH55 = rollingHighExclToday(candles, 55);
  const freshness = breakoutFreshnessDays(candles, 20, 10);
  const cir = closeInRangePct(last);
  const base = baseMetrics(candles, 30);

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
    ema20Series: e20,
    ema50Series: e50,
    ema200Series: e200,
  };
}
