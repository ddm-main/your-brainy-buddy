// Extended pattern detection: multi-bar structures beyond the classic
// reversal set, plus point-in-time reads (gaps, bar volatility, volume,
// moving-average crosses and market-structure / SMC events).
//
// Every tolerance here is ATR-scaled or bar-count based, so the same code is
// valid on 1m candles and on monthly candles. Nothing looks ahead: a read at
// bar `i` uses only bars <= i.
//
// `pattern-series.ts` merges these flags into `detectPatternsExtended`, so
// they flow to the chart overlays, the Analysis panel and the v4 scorer from
// one place.

import type { Candle } from "./indicators.ts";
import type { CandleMark, PatternTone } from "./pattern-series.ts";

// --------------------------------------------------------------- flag shape
export interface StructureFlags {
  // reversal
  triple_top: boolean;
  triple_bottom: boolean;
  rounded_top: boolean;
  rounded_bottom: boolean;
  inverse_cup_and_handle: boolean;
  // continuation
  bear_flag: boolean;
  bull_pennant: boolean;
  bear_pennant: boolean;
  symmetrical_triangle: boolean;
  rectangle: boolean;
  // channels
  ascending_channel: boolean;
  descending_channel: boolean;
  horizontal_channel: boolean;
  broadening: boolean;
  // bars / volatility
  inside_bar: boolean;
  outside_bar: boolean;
  nr4: boolean;
  nr7: boolean;
  bb_squeeze: boolean;
  volatility_breakout: boolean;
  // gaps
  gap_up: boolean;
  gap_down: boolean;
  breakaway_gap: boolean;
  runaway_gap: boolean;
  exhaustion_gap: boolean;
  // volume
  volume_breakout: boolean;
  volume_climax: boolean;
  volume_dryup: boolean;
  accumulation: boolean;
  distribution: boolean;
  // trend / moving averages / levels
  golden_cross: boolean;
  death_cross: boolean;
  ma_bounce: boolean;
  support_bounce: boolean;
  resistance_rejection: boolean;
  trendline_break: boolean;
  // market structure (SMC)
  higher_high: boolean;
  higher_low: boolean;
  lower_high: boolean;
  lower_low: boolean;
  bos_up: boolean;
  bos_down: boolean;
  choch_up: boolean;
  choch_down: boolean;
  liquidity_sweep_high: boolean;
  liquidity_sweep_low: boolean;
  fvg_up: boolean;
  fvg_down: boolean;
  order_block_bull: boolean;
  order_block_bear: boolean;
  // wyckoff (light)
  wyckoff_accumulation: boolean;
  wyckoff_distribution: boolean;
  wyckoff_spring: boolean;
  wyckoff_upthrust: boolean;
}

export const EMPTY_STRUCTURE_FLAGS: StructureFlags = {
  triple_top: false, triple_bottom: false, rounded_top: false, rounded_bottom: false,
  inverse_cup_and_handle: false, bear_flag: false, bull_pennant: false, bear_pennant: false,
  symmetrical_triangle: false, rectangle: false, ascending_channel: false, descending_channel: false,
  horizontal_channel: false, broadening: false, inside_bar: false, outside_bar: false,
  nr4: false, nr7: false, bb_squeeze: false, volatility_breakout: false,
  gap_up: false, gap_down: false, breakaway_gap: false, runaway_gap: false, exhaustion_gap: false,
  volume_breakout: false, volume_climax: false, volume_dryup: false, accumulation: false,
  distribution: false, golden_cross: false, death_cross: false, ma_bounce: false,
  support_bounce: false, resistance_rejection: false, trendline_break: false,
  higher_high: false, higher_low: false, lower_high: false, lower_low: false,
  bos_up: false, bos_down: false, choch_up: false, choch_down: false,
  liquidity_sweep_high: false, liquidity_sweep_low: false, fvg_up: false, fvg_down: false,
  order_block_bull: false, order_block_bear: false, wyckoff_accumulation: false,
  wyckoff_distribution: false, wyckoff_spring: false, wyckoff_upthrust: false,
};

// ------------------------------------------------------------------ helpers
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function atrAt(candles: Candle[], period = 14): number {
  const n = candles.length;
  if (n < 2) return 0;
  const p = Math.min(period, n - 1);
  let sum = 0;
  for (let i = n - p; i < n; i++) {
    const c = candles[i], q = candles[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - q.close), Math.abs(c.low - q.close));
  }
  return sum / p;
}

/** Least-squares slope of `ys` against index, normalised by mean level. */
function slopePct(ys: number[]): number {
  const n = ys.length;
  if (n < 3) return 0;
  const mx = (n - 1) / 2;
  const my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (ys[i] - my); den += (i - mx) ** 2; }
  if (den === 0 || my === 0) return 0;
  return (num / den) / my; // fractional change per bar
}

export interface Swing { index: number; price: number; kind: "high" | "low" }

/** Fractal pivots with a `k`-bar shoulder on each side. */
export function swingPoints(candles: Candle[], k = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: candles[i].high, kind: "high" });
    else if (isLow) out.push({ index: i, price: candles[i].low, kind: "low" });
  }
  return out;
}

// ------------------------------------------------------------ market structure
export interface StructureRead {
  label: "HH" | "HL" | "LH" | "LL" | null;
  bos: "up" | "down" | null;
  choch: "up" | "down" | null;
  lastHigh: number | null;
  lastLow: number | null;
  swings: Swing[];
}

export function readMarketStructure(candles: Candle[], k = 3): StructureRead {
  const swings = swingPoints(candles, k);
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const res: StructureRead = {
    label: null, bos: null, choch: null,
    lastHigh: highs.length ? highs[highs.length - 1].price : null,
    lastLow: lows.length ? lows[lows.length - 1].price : null,
    swings,
  };
  if (swings.length === 0 || candles.length === 0) return res;

  const last = swings[swings.length - 1];
  const prevSame = [...swings].reverse().find((s, idx) => idx > 0 && s.kind === last.kind);
  if (prevSame) {
    if (last.kind === "high") res.label = last.price > prevSame.price ? "HH" : "LH";
    else res.label = last.price > prevSame.price ? "HL" : "LL";
  }

  // Break of structure: close beyond the most recent opposing swing.
  const c = candles[candles.length - 1];
  const upTrend = highs.length >= 2 && lows.length >= 2 &&
    highs[highs.length - 1].price > highs[highs.length - 2].price &&
    lows[lows.length - 1].price > lows[lows.length - 2].price;
  const downTrend = highs.length >= 2 && lows.length >= 2 &&
    highs[highs.length - 1].price < highs[highs.length - 2].price &&
    lows[lows.length - 1].price < lows[lows.length - 2].price;

  if (res.lastHigh != null && c.close > res.lastHigh) res.bos = "up";
  if (res.lastLow != null && c.close < res.lastLow) res.bos = res.bos === "up" ? res.bos : "down";
  // Change of character: a break AGAINST the prevailing swing sequence.
  if (downTrend && res.bos === "up") res.choch = "up";
  if (upTrend && res.bos === "down") res.choch = "down";
  return res;
}

// -------------------------------------------------------------- flag builder
export function structureFlags(candles: Candle[]): StructureFlags {
  const f: StructureFlags = { ...EMPTY_STRUCTURE_FLAGS };
  const n = candles.length;
  if (n < 6) return f;
  const c = candles[n - 1], p = candles[n - 2];
  const atr = Math.max(1e-9, atrAt(candles));
  const range = c.high - c.low;

  // ---- bars / volatility
  f.inside_bar = c.high <= p.high && c.low >= p.low;
  f.outside_bar = c.high > p.high && c.low < p.low;
  const ranges = candles.slice(-7).map((x) => x.high - x.low);
  if (ranges.length >= 4) f.nr4 = range <= Math.min(...ranges.slice(-4));
  if (ranges.length >= 7) f.nr7 = range <= Math.min(...ranges);

  if (n >= 25) {
    const closes = candles.slice(-20).map((x) => x.close);
    const m = mean(closes);
    const sd = Math.sqrt(mean(closes.map((x) => (x - m) ** 2)));
    const width = m > 0 ? (4 * sd) / m : 0;
    const hist: number[] = [];
    for (let i = n - 20; i >= Math.max(20, n - 120); i -= 5) {
      const w = candles.slice(i - 20, i).map((x) => x.close);
      const mm = mean(w);
      const ss = Math.sqrt(mean(w.map((x) => (x - mm) ** 2)));
      if (mm > 0) hist.push((4 * ss) / mm);
    }
    if (hist.length >= 3) f.bb_squeeze = width <= Math.min(...hist) * 1.05;
    f.volatility_breakout = range >= 1.8 * atr && Math.abs(c.close - c.open) >= 0.6 * range;
  }

  // ---- gaps
  const gapUp = c.low > p.high;
  const gapDown = c.high < p.low;
  f.gap_up = gapUp && (c.low - p.high) >= 0.15 * atr;
  f.gap_down = gapDown && (p.low - c.high) >= 0.15 * atr;
  if (f.gap_up || f.gap_down) {
    const w = candles.slice(-25, -1);
    const hi = Math.max(...w.map((x) => x.high));
    const lo = Math.min(...w.map((x) => x.low));
    const priorRange = hi - lo;
    const tight = priorRange <= 6 * atr;
    const trendUp = w.length > 5 && w[w.length - 1].close > w[0].close * 1.05;
    const trendDown = w.length > 5 && w[w.length - 1].close < w[0].close * 0.95;
    const vols = candles.slice(-21, -1).map((x) => x.volume || 0);
    const avgVol = mean(vols);
    const volSurge = avgVol > 0 && (c.volume || 0) >= 2 * avgVol;
    // Out of a base = breakaway; mid-trend = runaway; blow-off on volume = exhaustion.
    if (tight) f.breakaway_gap = true;
    else if ((f.gap_up && trendUp) || (f.gap_down && trendDown)) {
      if (volSurge) f.exhaustion_gap = true; else f.runaway_gap = true;
    }
  }

  // ---- volume
  const vols = candles.slice(-21, -1).map((x) => x.volume || 0);
  const avgVol = mean(vols);
  const vol = c.volume || 0;
  if (avgVol > 0) {
    f.volume_dryup = vol <= 0.6 * avgVol;
    f.volume_climax = vol >= 3 * avgVol && range >= 1.5 * atr;
    const w = candles.slice(-21, -1);
    const priorHigh = w.length ? Math.max(...w.map((x) => x.high)) : c.high;
    f.volume_breakout = vol >= 1.8 * avgVol && c.close > priorHigh;
    // Accumulation / distribution: 20-bar money flow direction inside a range.
    const recent = candles.slice(-20);
    let mf = 0, totVol = 0;
    for (const x of recent) {
      const r = x.high - x.low;
      const mult = r > 0 ? ((x.close - x.low) - (x.high - x.close)) / r : 0;
      mf += mult * (x.volume || 0);
      totVol += x.volume || 0;
    }
    const flow = totVol > 0 ? mf / totVol : 0;
    const hi = Math.max(...recent.map((x) => x.high));
    const lo = Math.min(...recent.map((x) => x.low));
    const ranging = hi > 0 && (hi - lo) / hi <= 0.18;
    f.accumulation = ranging && flow >= 0.15;
    f.distribution = ranging && flow <= -0.15;
    // Wyckoff requires an event against a PRIOR mature range. The previous
    // implementation measured `lo`/`hi` including the current candle, making
    // a real spring/upthrust mathematically impossible, then promoted plain
    // money-flow direction to a Wyckoff structure. Keep accumulation and
    // distribution as context, but reserve the Wyckoff labels for an actual
    // sweep-and-reclaim/reject event.
    if (ranging && n >= 30) {
      const prior = candles.slice(-21, -1);
      const priorHi = Math.max(...prior.map((x) => x.high));
      const priorLo = Math.min(...prior.map((x) => x.low));
      const priorSpan = Math.max(1e-9, priorHi - priorLo);
      const matureRange = priorSpan / Math.max(priorHi, 1e-9) <= 0.18;
      f.wyckoff_spring = matureRange && c.low < priorLo - 0.05 * atr && c.close > priorLo + 0.15 * priorSpan;
      f.wyckoff_upthrust = matureRange && c.high > priorHi + 0.05 * atr && c.close < priorHi - 0.15 * priorSpan;
      f.wyckoff_accumulation = f.accumulation && f.wyckoff_spring;
      f.wyckoff_distribution = f.distribution && f.wyckoff_upthrust;
    }
  }

  // ---- moving-average crosses / bounce
  if (n >= 60) {
    const sma = (len: number, off: number) => {
      const w = candles.slice(n - len - off, n - off);
      return w.length ? mean(w.map((x) => x.close)) : null;
    };
    const fastLen = Math.min(50, Math.floor(n / 4));
    const slowLen = Math.min(200, n - 2);
    const f0 = sma(fastLen, 0), s0 = sma(slowLen, 0), f1 = sma(fastLen, 1), s1 = sma(slowLen, 1);
    if (f0 != null && s0 != null && f1 != null && s1 != null) {
      f.golden_cross = f1 <= s1 && f0 > s0;
      f.death_cross = f1 >= s1 && f0 < s0;
    }
    const ma50 = sma(Math.min(50, n - 2), 0);
    if (ma50 != null) {
      f.ma_bounce = c.low <= ma50 * 1.01 && c.close > ma50 && c.close > c.open;
    }
  }

  // ---- levels
  if (n >= 25) {
    const w = candles.slice(-Math.min(60, n - 1), -1);
    const hi = Math.max(...w.map((x) => x.high));
    const lo = Math.min(...w.map((x) => x.low));
    f.support_bounce = c.low <= lo + 0.4 * atr && c.close > c.open && c.close > lo + 0.6 * atr;
    f.resistance_rejection = c.high >= hi - 0.4 * atr && c.close < c.open && c.close < hi - 0.6 * atr;
    // Trendline break: close through the regression line of the last 20 lows/highs.
    const seg = candles.slice(-20);
    const lows = seg.map((x) => x.low);
    const highs = seg.map((x) => x.high);
    const upSlope = slopePct(lows), downSlope = slopePct(highs);
    if (upSlope > 0.001) f.trendline_break = c.close < Math.min(...lows.slice(-5)) - 0.2 * atr;
    else if (downSlope < -0.001) f.trendline_break = c.close > Math.max(...highs.slice(-5)) + 0.2 * atr;
  }

  // ---- market structure / SMC
  const ms = readMarketStructure(candles);
  f.higher_high = ms.label === "HH";
  f.higher_low = ms.label === "HL";
  f.lower_high = ms.label === "LH";
  f.lower_low = ms.label === "LL";
  f.bos_up = ms.bos === "up";
  f.bos_down = ms.bos === "down";
  f.choch_up = ms.choch === "up";
  f.choch_down = ms.choch === "down";
  if (ms.lastHigh != null) f.liquidity_sweep_high = c.high > ms.lastHigh && c.close < ms.lastHigh;
  if (ms.lastLow != null) f.liquidity_sweep_low = c.low < ms.lastLow && c.close > ms.lastLow;
  // Fair value gap on the last three bars (imbalance between bar i-2 and i).
  if (n >= 3) {
    const a = candles[n - 3];
    f.fvg_up = c.low > a.high && (c.low - a.high) >= 0.1 * atr;
    f.fvg_down = c.high < a.low && (a.low - c.high) >= 0.1 * atr;
  }
  // Order block: last opposing candle before a decisive displacement leg.
  if (n >= 4) {
    const disp = Math.abs(c.close - c.open) >= 1.2 * atr;
    if (disp && c.close > c.open && p.close < p.open) f.order_block_bull = true;
    if (disp && c.close < c.open && p.close > p.open) f.order_block_bear = true;
  }

  // ---- multi-bar structures
  Object.assign(f, multiBarStructures(candles, atr));
  return f;
}

// ------------------------------------------------------- multi-bar structures
function multiBarStructures(candles: Candle[], atr: number): Partial<StructureFlags> {
  const out: Partial<StructureFlags> = {};
  const n = candles.length;
  const c = candles[n - 1];

  // --- triple top / bottom: three pivots within 3% of each other.
  if (n >= 45) {
    const w = candles.slice(-Math.min(90, n));
    const sw = swingPoints(w, 3);
    const highs = sw.filter((s) => s.kind === "high").slice(-3);
    const lows = sw.filter((s) => s.kind === "low").slice(-3);
    if (highs.length === 3) {
      const avg = mean(highs.map((s) => s.price));
      const tight = highs.every((s) => Math.abs(s.price - avg) / avg <= 0.03);
      const trough = Math.min(...w.slice(highs[0].index, highs[2].index + 1).map((x) => x.low));
      out.triple_top = tight && (avg - trough) / avg >= 0.04 && c.close <= trough * 1.03;
    }
    if (lows.length === 3) {
      const avg = mean(lows.map((s) => s.price));
      const tight = avg > 0 && lows.every((s) => Math.abs(s.price - avg) / avg <= 0.03);
      const peak = Math.max(...w.slice(lows[0].index, lows[2].index + 1).map((x) => x.high));
      out.triple_bottom = tight && (peak - avg) / avg >= 0.04 && c.close >= peak * 0.97;
    }
  }

  // --- rounded top / bottom: smooth arc across 40+ bars.
  if (n >= 40) {
    const w = candles.slice(-40);
    const closes = w.map((x) => x.close);
    const first = mean(closes.slice(0, 8));
    const mid = mean(closes.slice(16, 24));
    const last = mean(closes.slice(-8));
    const edgeSim = Math.abs(first - last) / Math.max(first, last) <= 0.06;
    out.rounded_bottom = edgeSim && mid < Math.min(first, last) * 0.94;
    out.rounded_top = edgeSim && mid > Math.max(first, last) * 1.06;
  }

  // --- inverse cup & handle (bearish mirror of a rounded top + small pause).
  if (n >= 50) {
    const w = candles.slice(-50);
    const cup = w.slice(0, 40).map((x) => x.close);
    const first = mean(cup.slice(0, 6)), mid = mean(cup.slice(17, 23)), last = mean(cup.slice(-6));
    const handle = w.slice(40);
    const handleUp = handle.length >= 5 && Math.max(...handle.map((x) => x.high)) < mid * 1.03 &&
      handle[handle.length - 1].close < mid;
    out.inverse_cup_and_handle =
      Math.abs(first - last) / Math.max(first, last) <= 0.06 && mid > Math.max(first, last) * 1.06 && handleUp;
  }

  // --- flags / pennants: sharp impulse then a tight counter-drift.
  if (n >= 20) {
    const pole = candles.slice(-20, -6);
    const cons = candles.slice(-6);
    const poleMove = (pole[pole.length - 1].close - pole[0].close) / Math.max(1e-9, pole[0].close);
    const consHigh = Math.max(...cons.map((x) => x.high));
    const consLow = Math.min(...cons.map((x) => x.low));
    const consRange = consHigh - consLow;
    const tight = consRange <= 3 * atr;
    const drift = slopePct(cons.map((x) => x.close));
    const converging = (cons[0].high - cons[0].low) > (cons[cons.length - 1].high - cons[cons.length - 1].low) * 1.3;
    if (poleMove <= -0.08 && tight) {
      if (converging) out.bear_pennant = true; else if (drift > 0) out.bear_flag = true;
    }
    if (poleMove >= 0.08 && tight && converging) out.bull_pennant = true;
  }

  // --- symmetrical triangle / rectangle / channels / broadening (25 bars).
  if (n >= 25) {
    const w = candles.slice(-25);
    const highs = w.map((x) => x.high), lows = w.map((x) => x.low);
    const hs = slopePct(highs), ls = slopePct(lows);
    const firstWidth = Math.max(...highs.slice(0, 8)) - Math.min(...lows.slice(0, 8));
    const lastWidth = Math.max(...highs.slice(-8)) - Math.min(...lows.slice(-8));
    const flat = (s: number) => Math.abs(s) <= 0.0015;
    const upper = Math.max(...highs);
    const lower = Math.min(...lows);
    const touchTol = Math.max(0.35 * atr, (upper - lower) * 0.08);
    const upperTouches = highs.filter((v) => upper - v <= touchTol).length;
    const lowerTouches = lows.filter((v) => v - lower <= touchTol).length;
    const stableRange = lastWidth >= firstWidth * 0.7 && lastWidth <= firstWidth * 1.3;
    if (hs < -0.0015 && ls > 0.0015 && lastWidth < firstWidth * 0.8) out.symmetrical_triangle = true;
    // Rectangle and horizontal channel were byte-identical detectors and
    // produced two rows for one range. Rectangle is now the canonical range
    // structure and requires repeat tests of both boundaries.
    if (flat(hs) && flat(ls) && stableRange && upperTouches >= 2 && lowerTouches >= 2) out.rectangle = true;
    if (hs > 0.0015 && ls > 0.0015 && Math.abs(hs - ls) <= 0.002) out.ascending_channel = true;
    if (hs < -0.0015 && ls < -0.0015 && Math.abs(hs - ls) <= 0.002) out.descending_channel = true;
    out.horizontal_channel = false;
    if (hs > 0.0015 && ls < -0.0015 && lastWidth > firstWidth * 1.4) out.broadening = true;
  }

  return out;
}

// -------------------------------------------------- extra candlestick marks
/**
 * How many bars each candlestick read actually consumes, plus the rule that
 * produced it. Without this every mark claimed a one-bar window, so a
 * three-bar morning star drilled down to a single candle and the "detected
 * because" line was the same generic sentence for all 30 patterns.
 */
const CANDLE_SPEC: Record<string, { bars: number; formula: string }> = {
  marubozu_bull: { bars: 1, formula: "Body ≥ 90% of range and range ≥ 0.6 ATR, closing up — no meaningful wicks." },
  marubozu_bear: { bars: 1, formula: "Body ≥ 90% of range and range ≥ 0.6 ATR, closing down — no meaningful wicks." },
  bullish_engulfing: { bars: 2, formula: "Prior bar red; this bar green, body wraps the prior body, body ≥ 1.2× prior body and closes in the top 25% of its range." },
  bearish_engulfing: { bars: 2, formula: "Prior bar green; this bar red, body wraps the prior body, body ≥ 1.2× prior body and closes in the bottom 25% of its range." },
  bullish_harami: { bars: 2, formula: "Prior red body ≥ 0.5 ATR; this green body sits inside it and is ≤ 60% of its size." },
  bearish_harami: { bars: 2, formula: "Prior green body ≥ 0.5 ATR; this red body sits inside it and is ≤ 60% of its size." },
  piercing_line: { bars: 2, formula: "Opens below the prior red close and closes back above the prior body midpoint but under its open." },
  dark_cloud: { bars: 2, formula: "Opens above the prior green close and closes back below the prior body midpoint but over its open." },
  morning_star: { bars: 3, formula: "Decisive red bar, small-bodied middle bar (≤ 40% of it), then a green close above the first bar's midpoint." },
  evening_star: { bars: 3, formula: "Decisive green bar, small-bodied middle bar (≤ 40% of it), then a red close below the first bar's midpoint." },
  three_white_soldiers: { bars: 3, formula: "Three consecutive green bars, each body ≥ 50% of its range, with successively higher closes." },
  three_black_crows: { bars: 3, formula: "Three consecutive red bars, each body ≥ 50% of its range, with successively lower closes." },
  hammer: { bars: 1, formula: "Lower wick > 2× body and ≥ 50% of range, small upper wick, after a 5-bar downtrend." },
  hanging_man: { bars: 1, formula: "Same hammer geometry, but it appears after a 5-bar uptrend." },
  inverted_hammer: { bars: 1, formula: "Upper wick > 2× body and ≥ 50% of range, small lower wick, after a 5-bar downtrend." },
  shooting_star: { bars: 1, formula: "Upper wick > 2× body and ≥ 50% of range, small lower wick, into an uptrend or flat context." },
  doji: { bars: 1, formula: "Range ≥ 0.5 ATR with body ≤ 10% of range, wicks roughly balanced." },
  dragonfly_doji: { bars: 1, formula: "Body ≤ 10% of range; lower wick ≥ 2× upper and ≥ 60% of range." },
  gravestone_doji: { bars: 1, formula: "Body ≤ 10% of range; upper wick ≥ 2× lower and ≥ 60% of range." },
  tweezer_bottom: { bars: 2, formula: "This low matches the prior low within 0.1 ATR after a red bar, closing green in a downtrend." },
  tweezer_top: { bars: 2, formula: "This high matches the prior high within 0.1 ATR after a green bar, closing red in an uptrend." },
  spinning_top: { bars: 1, formula: "Small body centred between two comparable wicks — indecision." },
  inside_bar: { bars: 2, formula: "High ≤ prior high and low ≥ prior low — the whole bar is inside the previous range." },
  outside_bar: { bars: 2, formula: "High > prior high and low < prior low — the bar engulfs the previous range." },
  nr7: { bars: 7, formula: "Narrowest range of the last 7 bars — compression before expansion." },
  gap_up: { bars: 2, formula: "Low opens above the prior high by ≥ 0.15 ATR." },
  gap_down: { bars: 2, formula: "High opens below the prior low by ≥ 0.15 ATR." },
  three_inside_up: { bars: 3, formula: "Bullish harami followed by a close above the harami's high." },
  three_inside_down: { bars: 3, formula: "Bearish harami followed by a close below the harami's low." },
  three_outside_up: { bars: 3, formula: "Bullish engulfing followed by a further green close above it." },
  three_outside_down: { bars: 3, formula: "Bearish engulfing followed by a further red close below it." },
  rising_three_methods: { bars: 5, formula: "Long green bar, three small pullback bars held inside its range, then a green close above its high." },
  falling_three_methods: { bars: 5, formula: "Long red bar, three small bounce bars held inside its range, then a red close below its low." },
  tasuki_gap_bull: { bars: 3, formula: "Upside gap between two green bars, then a red bar that partially fills but does not close the gap." },
  tasuki_gap_bear: { bars: 3, formula: "Downside gap between two red bars, then a green bar that partially fills but does not close the gap." },
  mat_hold: { bars: 5, formula: "Strong green bar, a gap up, shallow consolidation that holds above its midpoint, then a new green breakout close." },
};

export const makeCandleMark = (index: number, key: string, label: string, short: string, tone: PatternTone): CandleMark => {
  const spec = CANDLE_SPEC[key];
  return {
    index, key, label, short, tone, status: "confirmed",
    startIndex: Math.max(0, index - ((spec?.bars ?? 1) - 1)),
    endIndex: index, confidence: 70,
    formula: spec?.formula ?? "Candle geometry and prior-bar context satisfy the pattern rule.",
  };
};
const M = makeCandleMark;

/**
 * Candlestick / bar reads that complete AT bar `i` and are not covered by the
 * classic set in `pattern-series.ts`.
 */
export function extraCandleMarksAt(candles: Candle[], i: number, atr: number | null): CandleMark[] {
  const out: CandleMark[] = [];
  if (i < 2) return out;
  const c = candles[i], p = candles[i - 1], p2 = candles[i - 2];
  const range = c.high - c.low;
  if (range <= 0) return out;
  const a = atr && atr > 0 ? atr : range;
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const green = c.close > c.open, red = c.close < c.open;

  // Spinning top — small body with meaningful wicks on both sides.
  if (body / range <= 0.3 && upper >= 0.25 * range && lower >= 0.25 * range && range >= 0.5 * a) {
    out.push(M(i, "spinning_top", "Spinning top", "ST", "neutral"));
  }

  // Inside / outside bar.
  if (c.high <= p.high && c.low >= p.low) out.push(M(i, "inside_bar", "Inside bar", "IB", "neutral"));
  if (c.high > p.high && c.low < p.low) out.push(M(i, "outside_bar", "Outside bar", "OB", "neutral"));

  // NR7 — narrowest range of the last seven bars.
  if (i >= 6) {
    const rr = candles.slice(i - 6, i + 1).map((x) => x.high - x.low);
    if (range <= Math.min(...rr)) out.push(M(i, "nr7", "NR7 (narrow range)", "NR7", "neutral"));
  }

  // Gaps.
  if (c.low > p.high && (c.low - p.high) >= 0.15 * a) out.push(M(i, "gap_up", "Gap up", "G↑", "bullish"));
  if (c.high < p.low && (p.low - c.high) >= 0.15 * a) out.push(M(i, "gap_down", "Gap down", "G↓", "bearish"));

  // Three inside up / down — harami then confirmation.
  const p2Body = Math.abs(p2.close - p2.open);
  const inside = Math.max(p.open, p.close) <= Math.max(p2.open, p2.close) &&
    Math.min(p.open, p.close) >= Math.min(p2.open, p2.close);
  if (inside && p2Body >= 0.5 * a) {
    if (p2.close < p2.open && green && c.close > p2.open) {
      out.push(M(i, "three_inside_up", "Three inside up", "3IU", "bullish"));
    }
    if (p2.close > p2.open && red && c.close < p2.open) {
      out.push(M(i, "three_inside_down", "Three inside down", "3ID", "bearish"));
    }
  }

  // Three outside up / down — engulfing then confirmation.
  const engulfBull = p2.close < p2.open && p.close > p.open && p.close >= p2.open && p.open <= p2.close;
  const engulfBear = p2.close > p2.open && p.close < p.open && p.open >= p2.close && p.close <= p2.open;
  if (engulfBull && green && c.close > p.close) out.push(M(i, "three_outside_up", "Three outside up", "3OU", "bullish"));
  if (engulfBear && red && c.close < p.close) out.push(M(i, "three_outside_down", "Three outside down", "3OD", "bearish"));

  // Rising / falling three methods — 5-bar continuation.
  if (i >= 4) {
    const b = candles.slice(i - 4, i + 1);
    const [b0, b1, b2, b3, b4] = b;
    const b0Body = Math.abs(b0.close - b0.open);
    const smallMiddle = [b1, b2, b3].every((x) =>
      Math.abs(x.close - x.open) <= 0.5 * b0Body &&
      x.high <= b0.high && x.low >= b0.low);
    if (b0.close > b0.open && b0Body >= 0.5 * a && smallMiddle && b4.close > b0.close && b4.close > b4.open) {
      out.push(M(i, "rising_three_methods", "Rising three methods", "R3M", "bullish"));
    }
    if (b0.close < b0.open && b0Body >= 0.5 * a && smallMiddle && b4.close < b0.close && b4.close < b4.open) {
      out.push(M(i, "falling_three_methods", "Falling three methods", "F3M", "bearish"));
    }
  }

  // Tasuki gap — gap in the trend direction, partially filled by an opposing bar.
  const gapUpLeg = p2.close > p2.open && p.open > p2.close && p.close > p.open;
  if (gapUpLeg && red && c.open > p.open && c.open < p.close && c.close < p.open && c.close > p2.close) {
    out.push(M(i, "tasuki_gap_bull", "Upside tasuki gap", "TG", "bullish"));
  }
  const gapDownLeg = p2.close < p2.open && p.open < p2.close && p.close < p.open;
  if (gapDownLeg && green && c.open < p.open && c.open > p.close && c.close > p.open && c.close < p2.close) {
    out.push(M(i, "tasuki_gap_bear", "Downside tasuki gap", "TG", "bearish"));
  }

  // Mat hold — gap-up continuation that holds above the impulse midpoint.
  if (i >= 4) {
    const b = candles.slice(i - 4, i + 1);
    const [b0, b1, , , b4] = b;
    const mid = (b0.open + b0.close) / 2;
    const holds = b.slice(1, 4).every((x) => x.low > mid);
    if (b0.close > b0.open && Math.abs(b0.close - b0.open) >= 0.6 * a && b1.open > b0.close &&
        holds && b4.close > Math.max(b0.high, b1.high)) {
      out.push(M(i, "mat_hold", "Mat hold", "MH", "bullish"));
    }
  }

  return out;
}
