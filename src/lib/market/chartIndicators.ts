// Client-side indicator math for the Analysis chart workbench.
// All functions take the candle array and return per-candle values aligned by
// index (null until the indicator has enough history), so series can be built
// without any backend round-trip.
import type { CandleDto } from "@/lib/market/types";

export type Num = number | null;

export function sma(candles: CandleDto[], period: number): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(candles: CandleDto[], period: number): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i].close;
    if (i < period - 1) { seed += c; continue; }
    if (i === period - 1) { prev = (seed + c) / period; out[i] = prev; continue; }
    prev = c * k + (prev as number) * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function bollinger(candles: CandleDto[], period = 20, mult = 2): { upper: Num[]; mid: Num[]; lower: Num[] } {
  const mid = sma(candles, period);
  const upper: Num[] = new Array(candles.length).fill(null);
  const lower: Num[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const m = mid[i];
    if (m == null) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (candles[j].close - m) ** 2;
    const sd = Math.sqrt(acc / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { upper, mid, lower };
}

export function rsi(candles: CandleDto[], period = 14): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) {
        gain /= period; loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function macd(candles: CandleDto[], fast = 12, slow = 26, signalP = 9): { macd: Num[]; signal: Num[]; hist: Num[] } {
  const f = ema(candles, fast);
  const s = ema(candles, slow);
  const line: Num[] = candles.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
  // signal = EMA of the macd line, seeded at the first non-null run
  const signal: Num[] = new Array(candles.length).fill(null);
  const k = 2 / (signalP + 1);
  let prev: number | null = null;
  let seed: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const v = line[i];
    if (v == null) continue;
    if (prev == null) {
      seed.push(v);
      if (seed.length === signalP) {
        prev = seed.reduce((a, b) => a + b, 0) / signalP;
        signal[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    signal[i] = prev;
  }
  const hist: Num[] = line.map((v, i) => (v != null && signal[i] != null ? v - (signal[i] as number) : null));
  return { macd: line, signal, hist };
}

// Session-anchored VWAP — resets each trading day; only meaningful intraday.
export function vwap(candles: CandleDto[]): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  let pv = 0, vol = 0, day = "";
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = typeof c.time === "number" ? new Date(c.time * 1000).toISOString().slice(0, 10) : String(c.time);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

// ---- shared helpers ----------------------------------------------------

// Highest high over the trailing `period` bars ending at i (inclusive).
function highestHigh(candles: CandleDto[], i: number, period: number): number {
  let h = -Infinity;
  for (let j = i - period + 1; j <= i; j++) if (candles[j].high > h) h = candles[j].high;
  return h;
}
function lowestLow(candles: CandleDto[], i: number, period: number): number {
  let l = Infinity;
  for (let j = i - period + 1; j <= i; j++) if (candles[j].low < l) l = candles[j].low;
  return l;
}

// SMA over an arbitrary (possibly null-prefixed) numeric series.
function smaArr(vals: Num[], period: number): Num[] {
  const out: Num[] = new Array(vals.length).fill(null);
  let sum = 0, count = 0;
  const buf: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null) { sum = 0; count = 0; buf.length = 0; continue; }
    buf.push(v); sum += v; count++;
    if (count > period) { sum -= buf.shift() as number; count--; }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

// Weighted moving average (linear weights 1..period).
export function wma(candles: CandleDto[], period: number): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < candles.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += candles[i - j].close * (period - j);
    out[i] = acc / denom;
  }
  return out;
}

// Wilder's Average True Range.
export function atr(candles: CandleDto[], period = 14): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  if (candles.length === 0) return out;
  const tr: number[] = new Array(candles.length);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let prev = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < period) { prev += tr[i]; if (i === period - 1) { prev /= period; out[i] = prev; } continue; }
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Keltner Channels — EMA mid ± mult × ATR.
export function keltner(candles: CandleDto[], emaPeriod = 20, atrPeriod = 10, mult = 2): { upper: Num[]; mid: Num[]; lower: Num[] } {
  const mid = ema(candles, emaPeriod);
  const a = atr(candles, atrPeriod);
  const upper: Num[] = new Array(candles.length).fill(null);
  const lower: Num[] = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    if (mid[i] == null || a[i] == null) continue;
    upper[i] = (mid[i] as number) + mult * (a[i] as number);
    lower[i] = (mid[i] as number) - mult * (a[i] as number);
  }
  return { upper, mid, lower };
}

// Donchian Channels — rolling high/low.
export function donchian(candles: CandleDto[], period = 20): { upper: Num[]; mid: Num[]; lower: Num[] } {
  const upper: Num[] = new Array(candles.length).fill(null);
  const lower: Num[] = new Array(candles.length).fill(null);
  const mid: Num[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const u = highestHigh(candles, i, period);
    const l = lowestLow(candles, i, period);
    upper[i] = u; lower[i] = l; mid[i] = (u + l) / 2;
  }
  return { upper, mid, lower };
}

// Supertrend — returns the trailing stop line plus trend direction (+1 up / -1 down).
export function supertrend(candles: CandleDto[], atrPeriod = 10, mult = 3): { line: Num[]; dir: Array<1 | -1 | null> } {
  const a = atr(candles, atrPeriod);
  const line: Num[] = new Array(candles.length).fill(null);
  const dir: Array<1 | -1 | null> = new Array(candles.length).fill(null);
  let prevUpper: number | null = null, prevLower: number | null = null, prevST: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    if (a[i] == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + mult * (a[i] as number);
    const basicLower = hl2 - mult * (a[i] as number);
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
    const finalUpper: number = prevUpper == null || basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper;
    const finalLower: number = prevLower == null || basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower;
    let st: number, d: 1 | -1;
    if (prevST == null) { st = finalUpper; d = -1; }
    else if (prevST === prevUpper) { // was riding the upper band (downtrend)
      if (candles[i].close > finalUpper) { st = finalLower; d = 1; } else { st = finalUpper; d = -1; }
    } else { // was riding the lower band (uptrend)
      if (candles[i].close < finalLower) { st = finalUpper; d = -1; } else { st = finalLower; d = 1; }
    }
    line[i] = st; dir[i] = d;
    prevUpper = finalUpper; prevLower = finalLower; prevST = st;
  }
  return { line, dir };
}

// Parabolic SAR (Wilder). Returns SAR dot + trend direction per bar so
// consumers can colour the dots by trend (industry standard) instead of
// guessing from the price relationship.
export function psar(candles: CandleDto[], step = 0.02, max = 0.2): { sar: Num[]; dir: Array<1 | -1 | null> } {
  const sarOut: Num[] = new Array(candles.length).fill(null);
  const dirOut: Array<1 | -1 | null> = new Array(candles.length).fill(null);
  if (candles.length < 2) return { sar: sarOut, dir: dirOut };
  let bull = candles[1].close >= candles[0].close;
  let af = step;
  let ep = bull ? candles[0].high : candles[0].low;
  let sar = bull ? candles[0].low : candles[0].high;
  sarOut[0] = sar; dirOut[0] = bull ? 1 : -1;
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    sar = sar + af * (ep - sar);
    if (bull) {
      const lo1 = candles[i - 1].low, lo2 = i >= 2 ? candles[i - 2].low : lo1;
      sar = Math.min(sar, lo1, lo2);
      if (l < sar) { bull = false; sar = ep; ep = l; af = step; }
      else if (h > ep) { ep = h; af = Math.min(af + step, max); }
    } else {
      const hi1 = candles[i - 1].high, hi2 = i >= 2 ? candles[i - 2].high : hi1;
      sar = Math.max(sar, hi1, hi2);
      if (h > sar) { bull = true; sar = ep; ep = h; af = step; }
      else if (l < ep) { ep = l; af = Math.min(af + step, max); }
    }
    sarOut[i] = sar; dirOut[i] = bull ? 1 : -1;
  }
  return { sar: sarOut, dir: dirOut };
}

// Ichimoku Kinko Hyo — lines only (no forward/backward displacement).
export function ichimoku(candles: CandleDto[], conv = 9, base = 26, spanBP = 52): { tenkan: Num[]; kijun: Num[]; spanA: Num[]; spanB: Num[] } {
  const tenkan: Num[] = new Array(candles.length).fill(null);
  const kijun: Num[] = new Array(candles.length).fill(null);
  const spanA: Num[] = new Array(candles.length).fill(null);
  const spanB: Num[] = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    if (i >= conv - 1) tenkan[i] = (highestHigh(candles, i, conv) + lowestLow(candles, i, conv)) / 2;
    if (i >= base - 1) kijun[i] = (highestHigh(candles, i, base) + lowestLow(candles, i, base)) / 2;
    if (tenkan[i] != null && kijun[i] != null) spanA[i] = ((tenkan[i] as number) + (kijun[i] as number)) / 2;
    if (i >= spanBP - 1) spanB[i] = (highestHigh(candles, i, spanBP) + lowestLow(candles, i, spanBP)) / 2;
  }
  return { tenkan, kijun, spanA, spanB };
}

// Stochastic oscillator — %K (smoothed) and %D.
export function stochastic(candles: CandleDto[], kPeriod = 14, dPeriod = 3, smooth = 3): { k: Num[]; d: Num[] } {
  const rawK: Num[] = new Array(candles.length).fill(null);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const hh = highestHigh(candles, i, kPeriod);
    const ll = lowestLow(candles, i, kPeriod);
    rawK[i] = hh === ll ? 100 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const k = smaArr(rawK, smooth);
  const d = smaArr(k, dPeriod);
  return { k, d };
}

// Stochastic RSI — stochastic applied to the RSI series.
export function stochRsi(candles: CandleDto[], rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3): { k: Num[]; d: Num[] } {
  const r = rsi(candles, rsiPeriod);
  const raw: Num[] = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    if (i < stochPeriod - 1) continue;
    let hi = -Infinity, lo = Infinity, ok = true;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      const v = r[j];
      if (v == null) { ok = false; break; }
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
    if (!ok || r[i] == null) continue;
    raw[i] = hi === lo ? 100 : (((r[i] as number) - lo) / (hi - lo)) * 100;
  }
  const k = smaArr(raw, kPeriod);
  const d = smaArr(k, dPeriod);
  return { k, d };
}

// ADX / DMI (Wilder). Returns ADX plus +DI / -DI.
export function adx(candles: CandleDto[], period = 14): { adx: Num[]; plusDi: Num[]; minusDi: Num[] } {
  const n = candles.length;
  const plusDi: Num[] = new Array(n).fill(null);
  const minusDi: Num[] = new Array(n).fill(null);
  const adxOut: Num[] = new Array(n).fill(null);
  if (n < 2) return { adx: adxOut, plusDi, minusDi };
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  // Wilder-smoothed sums seeded at index `period` (sum of bars 1..period).
  let sTr = 0, sPlus = 0, sMinus = 0;
  const dx: Num[] = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (i <= period) {
      sTr += tr[i]; sPlus += plusDM[i]; sMinus += minusDM[i];
    } else {
      sTr = sTr - sTr / period + tr[i];
      sPlus = sPlus - sPlus / period + plusDM[i];
      sMinus = sMinus - sMinus / period + minusDM[i];
    }
    if (i >= period) {
      const pdi = sTr === 0 ? 0 : (100 * sPlus) / sTr;
      const mdi = sTr === 0 ? 0 : (100 * sMinus) / sTr;
      plusDi[i] = pdi; minusDi[i] = mdi;
      const sum = pdi + mdi;
      dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
    }
  }
  // ADX = Wilder EMA of DX, seeded as the mean of the first `period` DX values.
  let seedSum = 0, seedCount = 0, prev: number | null = null;
  for (let i = 0; i < n; i++) {
    if (dx[i] == null) continue;
    if (prev == null) {
      seedSum += dx[i] as number; seedCount++;
      if (seedCount === period) { prev = seedSum / period; adxOut[i] = prev; }
    } else {
      prev = (prev * (period - 1) + (dx[i] as number)) / period;
      adxOut[i] = prev;
    }
  }
  return { adx: adxOut, plusDi, minusDi };
}

// Commodity Channel Index.
export function cci(candles: CandleDto[], period = 20): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tp[j];
    const mean = sum / period;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - mean);
    const md = dev / period;
    out[i] = md === 0 ? 0 : (tp[i] - mean) / (0.015 * md);
  }
  return out;
}

// Williams %R.
export function williamsR(candles: CandleDto[], period = 14): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const hh = highestHigh(candles, i, period);
    const ll = lowestLow(candles, i, period);
    out[i] = hh === ll ? -50 : (-100 * (hh - candles[i].close)) / (hh - ll);
  }
  return out;
}

// Rate of Change (%).
export function roc(candles: CandleDto[], period = 12): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    const base = candles[i - period].close;
    out[i] = base === 0 ? null : ((candles[i].close - base) / base) * 100;
  }
  return out;
}

// On-Balance Volume.
export function obv(candles: CandleDto[]): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  if (candles.length === 0) return out;
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) acc += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) acc -= candles[i].volume;
    out[i] = acc;
  }
  return out;
}

// Money Flow Index.
export function mfi(candles: CandleDto[], period = 14): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const rmf = candles.map((c, i) => tp[i] * c.volume);
  for (let i = period; i < candles.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) pos += rmf[j];
      else if (tp[j] < tp[j - 1]) neg += rmf[j];
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

// ---- price source ------------------------------------------------------

export type Source = "close" | "open" | "high" | "low" | "hl2" | "hlc3" | "ohlc4";

export function sourceValues(candles: CandleDto[], source: Source = "close"): number[] {
  return candles.map((c) => {
    switch (source) {
      case "open": return c.open;
      case "high": return c.high;
      case "low": return c.low;
      case "hl2": return (c.high + c.low) / 2;
      case "hlc3": return (c.high + c.low + c.close) / 3;
      case "ohlc4": return (c.open + c.high + c.low + c.close) / 4;
      default: return c.close;
    }
  });
}

// ---- null-aware moving-average cores (operate on a value series) --------

// EMA over a possibly null-prefixed series (e.g. EMA of an EMA).
function emaNum(vals: Num[], period: number): Num[] {
  const out: Num[] = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null, seed = 0, count = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null) { if (prev == null) { seed = 0; count = 0; } continue; }
    if (prev == null) { seed += v; count++; if (count === period) { prev = seed / period; out[i] = prev; } }
    else { prev = v * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}

// WMA requiring a full non-null window.
function wmaNum(vals: Num[], period: number): Num[] {
  const out: Num[] = new Array(vals.length).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < vals.length; i++) {
    let acc = 0, ok = true;
    for (let j = 0; j < period; j++) { const v = vals[i - j]; if (v == null) { ok = false; break; } acc += v * (period - j); }
    if (ok) out[i] = acc / denom;
  }
  return out;
}

export const emaV = (vals: Num[], period: number): Num[] => emaNum(vals, period);
export const smaV = (vals: Num[], period: number): Num[] => smaArr(vals, period);
export const wmaV = (vals: Num[], period: number): Num[] => wmaNum(vals, period);

// Hull MA.
export function hmaV(vals: Num[], period: number): Num[] {
  const half = Math.max(1, Math.round(period / 2));
  const sq = Math.max(1, Math.round(Math.sqrt(period)));
  const w1 = wmaNum(vals, half);
  const w2 = wmaNum(vals, period);
  const diff: Num[] = vals.map((_, i) => (w1[i] != null && w2[i] != null ? 2 * (w1[i] as number) - (w2[i] as number) : null));
  return wmaNum(diff, sq);
}

// Double / Triple EMA.
export function demaV(vals: Num[], period: number): Num[] {
  const e1 = emaNum(vals, period);
  const e2 = emaNum(e1, period);
  return vals.map((_, i) => (e1[i] != null && e2[i] != null ? 2 * (e1[i] as number) - (e2[i] as number) : null));
}
export function temaV(vals: Num[], period: number): Num[] {
  const e1 = emaNum(vals, period), e2 = emaNum(e1, period), e3 = emaNum(e2, period);
  return vals.map((_, i) => (e1[i] != null && e2[i] != null && e3[i] != null ? 3 * (e1[i] as number) - 3 * (e2[i] as number) + (e3[i] as number) : null));
}

// Volume-weighted MA (needs volume, so candle-based + source price).
export function vwma(candles: CandleDto[], period: number, source: Source = "close"): Num[] {
  const src = sourceValues(candles, source);
  const out: Num[] = new Array(candles.length).fill(null);
  let pv = 0, vv = 0;
  const bufP: number[] = [], bufV: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const p = src[i] * candles[i].volume;
    bufP.push(p); bufV.push(candles[i].volume); pv += p; vv += candles[i].volume;
    if (bufP.length > period) { pv -= bufP.shift() as number; vv -= bufV.shift() as number; }
    if (bufP.length === period) out[i] = vv > 0 ? pv / vv : null;
  }
  return out;
}

// Rolling standard deviation.
export function stddevV(vals: Num[], period: number): Num[] {
  const out: Num[] = new Array(vals.length).fill(null);
  for (let i = period - 1; i < vals.length; i++) {
    let sum = 0, ok = true;
    for (let j = i - period + 1; j <= i; j++) { const v = vals[j]; if (v == null) { ok = false; break; } sum += v; }
    if (!ok) continue;
    const mean = sum / period;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += ((vals[j] as number) - mean) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

// Source-aware Bollinger + Moving-average Envelopes.
export function bollingerV(vals: Num[], period = 20, mult = 2): { upper: Num[]; mid: Num[]; lower: Num[] } {
  const mid = smaArr(vals, period);
  const sd = stddevV(vals, period);
  const upper = vals.map((_, i) => (mid[i] != null && sd[i] != null ? (mid[i] as number) + mult * (sd[i] as number) : null));
  const lower = vals.map((_, i) => (mid[i] != null && sd[i] != null ? (mid[i] as number) - mult * (sd[i] as number) : null));
  return { upper, mid, lower };
}
export function envelopesV(vals: Num[], period = 20, pct = 2): { upper: Num[]; mid: Num[]; lower: Num[] } {
  const mid = smaArr(vals, period);
  const upper = mid.map((m) => (m != null ? m * (1 + pct / 100) : null));
  const lower = mid.map((m) => (m != null ? m * (1 - pct / 100) : null));
  return { upper, mid, lower };
}

// Awesome Oscillator — SMA5(median) − SMA34(median).
export function ao(candles: CandleDto[], fast = 5, slow = 34): Num[] {
  const med = candles.map((c) => (c.high + c.low) / 2);
  const f = smaArr(med, fast), s = smaArr(med, slow);
  return candles.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
}

// Momentum.
export function mom(candles: CandleDto[], period = 10): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) out[i] = candles[i].close - candles[i - period].close;
  return out;
}

// TRIX — 1-bar %ROC of a triple-smoothed EMA of close.
export function trix(candles: CandleDto[], period = 15): Num[] {
  const close: Num[] = candles.map((c) => c.close);
  const e3 = emaNum(emaNum(emaNum(close, period), period), period);
  const out: Num[] = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const a = e3[i], b = e3[i - 1];
    if (a != null && b != null && b !== 0) out[i] = ((a - b) / b) * 100;
  }
  return out;
}

// Ultimate Oscillator.
export function uo(candles: CandleDto[], p1 = 7, p2 = 14, p3 = 28): Num[] {
  const n = candles.length;
  const out: Num[] = new Array(n).fill(null);
  const bp = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const pc = candles[i - 1].close;
    const low = Math.min(candles[i].low, pc), high = Math.max(candles[i].high, pc);
    bp[i] = candles[i].close - low;
    tr[i] = high - low;
  }
  const roll = (arr: number[], i: number, per: number) => { let s = 0; for (let j = i - per + 1; j <= i; j++) s += arr[j]; return s; };
  for (let i = p3; i < n; i++) {
    const t1 = roll(tr, i, p1), t2 = roll(tr, i, p2), t3 = roll(tr, i, p3);
    if (t1 === 0 || t2 === 0 || t3 === 0) { out[i] = 50; continue; }
    const a1 = roll(bp, i, p1) / t1, a2 = roll(bp, i, p2) / t2, a3 = roll(bp, i, p3) / t3;
    out[i] = (100 * (4 * a1 + 2 * a2 + a3)) / 7;
  }
  return out;
}

// Chaikin Money Flow.
export function cmf(candles: CandleDto[], period = 20): Num[] {
  const n = candles.length;
  const out: Num[] = new Array(n).fill(null);
  const mfv = candles.map((c) => { const rng = c.high - c.low; return rng === 0 ? 0 : (((c.close - c.low) - (c.high - c.close)) / rng) * c.volume; });
  for (let i = period - 1; i < n; i++) {
    let mSum = 0, vSum = 0;
    for (let j = i - period + 1; j <= i; j++) { mSum += mfv[j]; vSum += candles[j].volume; }
    out[i] = vSum === 0 ? 0 : mSum / vSum;
  }
  return out;
}

// Accumulation / Distribution line.
export function ad(candles: CandleDto[]): Num[] {
  const out: Num[] = new Array(candles.length).fill(null);
  let acc = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const rng = c.high - c.low;
    acc += rng === 0 ? 0 : (((c.close - c.low) - (c.high - c.close)) / rng) * c.volume;
    out[i] = acc;
  }
  return out;
}

// Aroon Up / Down.
export function aroon(candles: CandleDto[], period = 14): { up: Num[]; down: Num[] } {
  const n = candles.length;
  const up: Num[] = new Array(n).fill(null), down: Num[] = new Array(n).fill(null);
  // Divides by (period - 1) below — period=1 (e.g. a saved layout from
  // before the picker enforced a min of 2) would produce NaN/Infinity for
  // every bar rather than a merely-degenerate-but-finite result.
  if (period < 2) return { up, down };
  // Window is exactly `period` bars (TradingView convention).
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity, hIdx = i, lIdx = i;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high >= hi) { hi = candles[j].high; hIdx = j; }
      if (candles[j].low <= lo) { lo = candles[j].low; lIdx = j; }
    }
    up[i] = (100 * (period - 1 - (i - hIdx))) / (period - 1);
    down[i] = (100 * (period - 1 - (i - lIdx))) / (period - 1);
  }
  return { up, down };
}

// Vortex Indicator (+VI / −VI).
export function vortex(candles: CandleDto[], period = 14): { plus: Num[]; minus: Num[] } {
  const n = candles.length;
  const plus: Num[] = new Array(n).fill(null), minus: Num[] = new Array(n).fill(null);
  const vmP = new Array(n).fill(0), vmM = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    vmP[i] = Math.abs(candles[i].high - candles[i - 1].low);
    vmM[i] = Math.abs(candles[i].low - candles[i - 1].high);
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  for (let i = period; i < n; i++) {
    let sP = 0, sM = 0, sT = 0;
    for (let j = i - period + 1; j <= i; j++) { sP += vmP[j]; sM += vmM[j]; sT += tr[j]; }
    if (sT === 0) continue;
    plus[i] = sP / sT; minus[i] = sM / sT;
  }
  return { plus, minus };
}

// Chaikin Oscillator — EMA(fast, AD) − EMA(slow, AD).
export function chaikinOsc(candles: CandleDto[], fast = 3, slow = 10): Num[] {
  const adLine = ad(candles);
  const f = emaNum(adLine, fast), s = emaNum(adLine, slow);
  return candles.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
}
