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
