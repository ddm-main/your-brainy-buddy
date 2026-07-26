// Advanced indicators layered on top of indicators.ts.
// Pure TS; oldest → newest series alignment.

import type { Candle } from "./indicators.ts";
export { obv } from "./indicators.ts";

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
export interface PatternFlags {
  bullish_engulfing: boolean;
  bearish_engulfing: boolean;
  hammer: boolean;
  shooting_star: boolean;
  doji: boolean;
  cup_and_handle: boolean;
  flag: boolean;
  ascending_triangle: boolean;
}

export function detectPatterns(candles: Candle[]): PatternFlags {
  const flags: PatternFlags = {
    bullish_engulfing: false,
    bearish_engulfing: false,
    hammer: false,
    shooting_star: false,
    doji: false,
    cup_and_handle: false,
    flag: false,
    ascending_triangle: false,
  };
  const n = candles.length;
  if (n < 2) return flags;
  const c = candles[n - 1], p = candles[n - 2];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  // Engulfing
  flags.bullish_engulfing = p.close < p.open && c.close > c.open && c.close >= p.open && c.open <= p.close;
  flags.bearish_engulfing = p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open;
  // Hammer / Shooting star
  flags.hammer = range > 0 && lower > body * 2 && upper < body;
  flags.shooting_star = range > 0 && upper > body * 2 && lower < body;
  // Doji
  flags.doji = range > 0 && body / range < 0.1;

  // Cup-and-handle: rough — last 60 bars form U shape and last 10 bars pull back within upper third
  if (n >= 60) {
    const window = candles.slice(-60);
    const highs = window.map((c) => c.high);
    const lows = window.map((c) => c.low);
    const peakLeft = Math.max(...highs.slice(0, 10));
    const peakRight = Math.max(...highs.slice(-15, -5));
    const trough = Math.min(...lows.slice(15, 45));
    const depth = peakLeft - trough;
    if (
      depth > 0 &&
      Math.abs(peakLeft - peakRight) / peakLeft < 0.05 &&
      trough < peakLeft * 0.97 &&
      c.close > peakRight * 0.95 && c.close < peakRight * 1.05
    ) {
      flags.cup_and_handle = true;
    }
  }
  // Flag: strong impulse (>8% in 5 bars) then 5-bar tight range (<3%)
  if (n >= 12) {
    const impulseStart = candles[n - 12].close;
    const impulseEnd = candles[n - 6].close;
    const impulse = (impulseEnd - impulseStart) / impulseStart;
    const recentHi = Math.max(...candles.slice(-5).map((c) => c.high));
    const recentLo = Math.min(...candles.slice(-5).map((c) => c.low));
    const tight = (recentHi - recentLo) / recentLo;
    flags.flag = impulse > 0.08 && tight < 0.03;
  }
  // Ascending triangle: flat resistance + rising lows over last 20 bars
  if (n >= 20) {
    const w = candles.slice(-20);
    const hi = Math.max(...w.map((c) => c.high));
    const flatTop = w.filter((c) => c.high >= hi * 0.99).length >= 3;
    const firstHalfLow = Math.min(...w.slice(0, 10).map((c) => c.low));
    const secondHalfLow = Math.min(...w.slice(10).map((c) => c.low));
    flags.ascending_triangle = flatTop && secondHalfLow > firstHalfLow * 1.02;
  }
  return flags;
}
