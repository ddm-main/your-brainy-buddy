// Advanced indicators layered on top of indicators.ts.
// Pure TS; oldest → newest series alignment.

import type { Candle } from "./indicators.ts";
// (Historical `export { obv } from "./indicators.ts"` was dropped: no caller
// consumed the passthrough, and its value re-export made this module
// unimportable from the Vite-typechecked client bundle.)

// -------- VWAP (session or full-window rolling average) --------
export function vwap(candles: Candle[]): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
    out[i] = vol ? pv / vol : null;
  }
  return out;
}

// -------- Supertrend (period, multiplier) --------
export function supertrend(
  candles: Candle[],
  period = 10,
  mult = 3,
): { line: (number | null)[]; dir: (number | null)[] } {
  const n = candles.length;
  const line: (number | null)[] = new Array(n).fill(null);
  const dir: (number | null)[] = new Array(n).fill(null);
  if (n <= period) return { line, dir };
  // ATR (Wilder)
  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    );
  }
  const atr: number[] = new Array(n).fill(NaN);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  let prevUpper = 0, prevLower = 0, prevLine = 0, prevDir = 1;
  for (let i = period; i < n; i++) {
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    let upper = hl2 + mult * atr[i];
    let lower = hl2 - mult * atr[i];
    if (i > period) {
      upper = upper < prevUpper || candles[i - 1].close > prevUpper ? upper : prevUpper;
      lower = lower > prevLower || candles[i - 1].close < prevLower ? lower : prevLower;
    }
    let d = prevDir;
    if (prevLine === prevUpper && c.close > upper) d = 1;
    else if (prevLine === prevLower && c.close < lower) d = -1;
    const st = d === 1 ? lower : upper;
    line[i] = st;
    dir[i] = d;
    prevUpper = upper; prevLower = lower; prevLine = st; prevDir = d;
  }
  return { line, dir };
}

// OBV lived here too as a byte-for-byte duplicate of indicators.ts's obv() —
// re-exported above instead of redefined.

// -------- MFI (Money Flow Index) --------
export function mfi(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const mf = candles.map((c, i) => tp[i] * c.volume);
  for (let i = period; i < candles.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) pos += mf[j];
      else if (tp[j] < tp[j - 1]) neg += mf[j];
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

// -------- Bollinger %B --------
export function percentB(close: number, upper: number | null, lower: number | null): number | null {
  if (upper == null || lower == null || upper === lower) return null;
  return (close - lower) / (upper - lower);
}

// -------- Candlestick + basic chart pattern flags --------
//
// Design rules (v2, tightened Jul 2026):
//  - Every pattern is evaluated on the last COMPLETED bar (index n-1 when
//    the pipeline runs post-close; the live-recompute path passes the same
//    completed series — pattern flags must not flicker on a forming bar).
//  - Filters are decisive, not "any candle that looks vaguely like one" —
//    the old detector fired hammers on near-marubozu candles and dojis on
//    every compressed bar, drowning the score in noise.
//  - Multi-bar patterns adapt their window to available history and require
//    ATR-scaled tolerances (a 1% flat top is meaningless on ₹5,000 stocks).
export interface PatternFlags {
  bullish_engulfing: boolean;
  bearish_engulfing: boolean;
  hammer: boolean;
  shooting_star: boolean;
  doji: boolean;
  cup_and_handle: boolean;
  cup_and_handle_triggered: boolean;
  flag: boolean;
  ascending_triangle: boolean;
  double_bottom: boolean;
  inverse_head_shoulders: boolean;
  falling_wedge: boolean;
}

function atrLast(candles: Candle[], period = 14): number | null {
  // Local ATR — avoids a circular import with indicators.ts and matches the
  // formula used elsewhere (Wilder's).
  const n = candles.length;
  if (n < period + 1) return null;
  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  for (let i = period + 1; i < n; i++) prev = (prev * (period - 1) + tr[i]) / period;
  return prev;
}

export function detectPatterns(candles: Candle[]): PatternFlags {
  const flags: PatternFlags = {
    bullish_engulfing: false,
    bearish_engulfing: false,
    hammer: false,
    shooting_star: false,
    doji: false,
    cup_and_handle: false,
    cup_and_handle_triggered: false,
    flag: false,
    ascending_triangle: false,
    double_bottom: false,
    inverse_head_shoulders: false,
    falling_wedge: false,
  };
  const n = candles.length;
  if (n < 2) return flags;
  const c = candles[n - 1], p = candles[n - 2];
  const atr = atrLast(candles) ?? Math.max(1e-6, (c.high - c.low) || c.close * 0.01);
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const prevBody = Math.abs(p.close - p.open);

  // --- Bullish engulfing (decisive): prior red, current green, current body
  // ≥ 1.2× prior body, close in top 25% of the current range. The old detector
  // accepted a 0.01% engulf.
  flags.bullish_engulfing =
    p.close < p.open &&
    c.close > c.open &&
    c.close >= p.open &&
    c.open <= p.close &&
    body >= 1.2 * prevBody &&
    range > 0 &&
    (c.close - c.low) / range >= 0.75;

  // Bearish engulfing — mirror.
  flags.bearish_engulfing =
    p.close > p.open &&
    c.close < c.open &&
    c.open >= p.close &&
    c.close <= p.open &&
    body >= 1.2 * prevBody &&
    range > 0 &&
    (c.high - c.close) / range >= 0.75;

  // --- Hammer / shooting star (real, not marubozu): body/range < 0.35, long
  // wick > 2× body, opposite wick < body.
  const bodyRatio = range > 0 ? body / range : 1;
  flags.hammer = range > 0 && bodyRatio < 0.35 && lower > body * 2 && upper < body;
  flags.shooting_star = range > 0 && bodyRatio < 0.35 && upper > body * 2 && lower < body;

  // --- Doji: range must be at least 0.5×ATR AND body ≤ 10% of range.
  // Compressed nothing-bars no longer register as indecision.
  flags.doji = range >= 0.5 * atr && range > 0 && body / range <= 0.1;

  // --- Cup & handle — data-adaptive 40..90 bar window, symmetric rims,
  // handle in the upper third, optional triggered flag when the right rim is
  // cleared.
  if (n >= 40) {
    const win = candles.slice(-Math.min(90, n));
    const L = win.length;
    const rimL = Math.max(4, Math.floor(L * 0.2));
    const rimR = Math.max(4, Math.floor(L * 0.2));
    const leftRim = Math.max(...win.slice(0, rimL).map((c) => c.close));
    const rightRim = Math.max(...win.slice(-rimR).map((c) => c.close));
    const mid = win.slice(rimL, L - rimR);
    const trough = mid.length ? Math.min(...mid.map((c) => c.low)) : leftRim;
    const depth = leftRim - trough;
    const cupOk = depth > 0 &&
      Math.abs(leftRim - rightRim) / leftRim <= 0.10 &&                 // symmetric rims (10%)
      depth / leftRim >= 0.12 && depth / leftRim <= 0.33;                // 12..33% cup depth
    // Handle = last 5..15 bars, tight, retracing < 40% of cup depth.
    const handleLen = Math.min(15, Math.max(5, Math.floor(L * 0.15)));
    const handle = win.slice(-handleLen);
    const handleHi = Math.max(...handle.map((c) => c.high));
    const handleLo = Math.min(...handle.map((c) => c.low));
    const handleTight = handleHi > 0 ? (handleHi - handleLo) / handleHi : 1;
    const handlePullback = rightRim > 0 ? (rightRim - handleLo) / depth : 1;
    const handleOk = cupOk && handleTight < 0.05 && handlePullback < 0.40;
    flags.cup_and_handle = handleOk;
    flags.cup_and_handle_triggered = handleOk && c.close > rightRim + 0.1 * atr;
  }

  // --- Flag: search 5..15 bars back for the impulse start; require > 8%
  // impulse, current 5-bar tight range < 4%, pullback < 50% of impulse.
  if (n >= 12) {
    for (let back = 8; back <= 15 && back < n - 5; back++) {
      const impulseStart = candles[n - back].close;
      const impulseEnd = candles[n - 5].close;
      if (impulseStart <= 0) continue;
      const impulse = (impulseEnd - impulseStart) / impulseStart;
      if (impulse < 0.08) continue;
      const last5 = candles.slice(-5);
      const hi = Math.max(...last5.map((c) => c.high));
      const lo = Math.min(...last5.map((c) => c.low));
      const tight = hi > 0 ? (hi - lo) / hi : 1;
      const pullback = impulseEnd > 0 ? (impulseEnd - c.close) / (impulseEnd - impulseStart) : 1;
      if (tight < 0.04 && pullback < 0.50) { flags.flag = true; break; }
    }
  }

  // --- Ascending triangle: ATR-scaled flat-top tolerance, ≥3 touches on top,
  // ≥2 higher lows on bottom over the last 25 bars.
  if (n >= 25) {
    const w = candles.slice(-25);
    const hi = Math.max(...w.map((c) => c.high));
    const flatTol = Math.max(hi * 0.005, 0.5 * atr);
    const topTouches = w.filter((c) => hi - c.high <= flatTol).length;
    // Rising lows: split window into 3 buckets, each bucket's min must exceed the prior.
    const bkt = [w.slice(0, 8), w.slice(8, 17), w.slice(17)];
    const mins = bkt.map((b) => Math.min(...b.map((c) => c.low)));
    const risingLows = mins[1] > mins[0] * 1.005 && mins[2] > mins[1] * 1.005;
    flags.ascending_triangle = topTouches >= 3 && risingLows;
  }

  // --- Double bottom: two lows within 3% of each other, separated by a peak
  // ≥ 5% above them, over the last 40..80 bars, with the current close above
  // the peak (triggered) or within 3% of it (armed).
  if (n >= 40) {
    const w = candles.slice(-Math.min(80, n));
    // Find deepest low index in first 60% and deepest low in last 40%.
    const split = Math.floor(w.length * 0.55);
    const left = w.slice(0, split), right = w.slice(split);
    const iL = left.reduce((best, c, i) => c.low < left[best].low ? i : best, 0);
    const iR = right.reduce((best, c, i) => c.low < right[best].low ? i : best, 0);
    const lowL = left[iL].low, lowR = right[iR].low;
    const between = w.slice(iL + 1, split + iR);
    const peak = between.length ? Math.max(...between.map((c) => c.high)) : 0;
    const sim = lowL > 0 ? Math.abs(lowL - lowR) / lowL : 1;
    const rally = Math.min(lowL, lowR) > 0 ? (peak - Math.min(lowL, lowR)) / Math.min(lowL, lowR) : 0;
    flags.double_bottom = sim <= 0.03 && rally >= 0.05 && c.close >= peak * 0.97;
  }

  // --- Inverse head & shoulders: 3 troughs (L / H / R) with H the deepest,
  // shoulders within 5% of each other and above H by ≥3%, close breaking the
  // neckline (highest close between the shoulders).
  if (n >= 50) {
    const w = candles.slice(-Math.min(90, n));
    const third = Math.floor(w.length / 3);
    const seg = [w.slice(0, third), w.slice(third, 2 * third), w.slice(2 * third)];
    const lows = seg.map((s) => Math.min(...s.map((c) => c.low)));
    const [lS, lH, rS] = lows;
    const shouldersClose = Math.abs(lS - rS) / lS <= 0.05;
    const headDeeper = lH < lS * 0.97 && lH < rS * 0.97;
    const neckline = Math.max(...w.slice(third, 2 * third + third).map((c) => c.high));
    flags.inverse_head_shoulders = shouldersClose && headDeeper && c.close >= neckline * 0.98;
  }

  // --- Falling wedge: last ~20 bars with both highs and lows falling, but
  // lows falling slower (converging), and current close breaks the descending
  // trendline of highs.
  if (n >= 20) {
    const w = candles.slice(-20);
    const half = 10;
    const hi1 = Math.max(...w.slice(0, half).map((c) => c.high));
    const hi2 = Math.max(...w.slice(half).map((c) => c.high));
    const lo1 = Math.min(...w.slice(0, half).map((c) => c.low));
    const lo2 = Math.min(...w.slice(half).map((c) => c.low));
    const highsFall = hi2 < hi1 * 0.99;
    const lowsFall = lo2 < lo1;
    const converging = hi1 > 0 && lo1 > 0 && (hi1 - lo1) > (hi2 - lo2) * 1.10;
    flags.falling_wedge = highsFall && lowsFall && converging && c.close > hi2;
  }

  return flags;
}

// Convenience — is the pattern set "near" (within `atrsAway` ATRs of) a given
// price level? Used by scoring to gate context-aware pattern bonuses (e.g. a
// hammer only earns full bonus when it prints at support).
export function isNearLevel(close: number, level: number | null, atr: number | null, atrsAway = 0.5): boolean {
  if (level == null || atr == null || atr <= 0) return false;
  return Math.abs(close - level) / atr <= atrsAway;
}
