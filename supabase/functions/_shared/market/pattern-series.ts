// Per-bar candlestick + chart pattern detection.
//
// `indicators-advanced.ts` answers "what pattern is printing on the LAST bar
// of this series?" — enough for the EOD score, useless for drawing. This
// module evaluates every bar so the chart can mark them, and it does so
// timeframe-agnostically: every tolerance is ATR-scaled or bar-count based,
// so the same code is valid on 1m through monthly candles.
//
// It is also the source of the extended (bearish) chart-structure flags the
// v4 scorer consumes — see `detectPatternsExtended`.

import type { Candle } from "./indicators.ts";
import { detectPatterns, type PatternFlags } from "./indicators-advanced.ts";
import {
  extraCandleMarksAt, makeCandleMark, structureFlags, type StructureFlags,
} from "./pattern-structure.ts";

export type PatternTone = "bullish" | "bearish" | "neutral";

export interface CandleMark {
  index: number;
  key: string;
  label: string;
  short: string;
  tone: PatternTone;
  status: "confirmed";
  startIndex: number;
  endIndex: number;
  confidence: number;
  formula: string;
  /** Measured numbers behind the read — the same shape shapes use. */
  evidence?: Record<string, number>;
  /** Price that voids the read (pattern low for bullish, high for bearish). */
  invalidateLevel?: number | null;
  invalidateText?: string;
  confirmText?: string;
}

export interface ChartShape {
  key: string;
  label: string;
  tone: PatternTone;
  startIndex: number;
  endIndex: number;
  /** Breakout / neckline level, when the structure has one. */
  level: number | null;
  triggered: boolean;
  status: "forming" | "confirmed" | "triggered";
  confidence: number;
  upper: number | null;
  lower: number | null;
  triggerIndex: number | null;
  formula: string;
  confirmText: string;
  invalidateText: string;
  evidence: Record<string, number>;
}

export interface PatternSeries {
  marks: CandleMark[];
  shapes: ChartShape[];
}

/** Bearish chart structures — mirrors of the bullish set in indicators-advanced. */
export interface BearPatternFlags {
  double_top: boolean;
  head_shoulders: boolean;
  rising_wedge: boolean;
  descending_triangle: boolean;
}

export type ExtendedPatternFlags = PatternFlags & BearPatternFlags & StructureFlags;

// Trailing window used when evaluating a historical bar. Every multi-bar
// detector in indicators-advanced looks back at most 90 bars, so 150 keeps
// the ATR seed honest while making per-bar evaluation O(1).
const WINDOW = 150;

// ---------------------------------------------------------------- ATR series
function atrSeries(candles: Candle[], period = 14): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// ------------------------------------------------------- candlestick reads
const M = makeCandleMark;

/**
 * Candlestick patterns completed AT bar `i`. Pure geometry + short trend
 * context; no forward-looking data, so it is safe to call while a bar forms.
 */
export function candleMarksAt(candles: Candle[], i: number, atr: number | null): CandleMark[] {
  const out: CandleMark[] = [];
  if (i < 1) return out;
  const c = candles[i], p = candles[i - 1];
  const p2 = i >= 2 ? candles[i - 2] : null;
  const range = c.high - c.low;
  if (range <= 0) return out;
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const bodyRatio = body / range;
  const green = c.close > c.open;
  const red = c.close < c.open;
  const prevBody = Math.abs(p.close - p.open);
  const a = atr && atr > 0 ? atr : range;

  // Short trend context (5 bars before the pattern bar).
  const from = Math.max(0, i - 5);
  const prior = candles.slice(from, i);
  const downtrend = prior.length >= 3 && prior[prior.length - 1].close < prior[0].close;
  const uptrend = prior.length >= 3 && prior[prior.length - 1].close > prior[0].close;

  // --- Marubozu
  if (bodyRatio >= 0.9 && range >= 0.6 * a) {
    if (green) out.push(M(i, "marubozu_bull", "Bullish marubozu", "MB", "bullish"));
    else if (red) out.push(M(i, "marubozu_bear", "Bearish marubozu", "MB", "bearish"));
  }

  // --- Engulfing (same decisive rules as the EOD detector)
  if (p.close < p.open && green && c.close >= p.open && c.open <= p.close &&
      body >= 1.2 * prevBody && (c.close - c.low) / range >= 0.75) {
    out.push(M(i, "bullish_engulfing", "Bullish engulfing", "BE", "bullish"));
  }
  if (p.close > p.open && red && c.open >= p.close && c.close <= p.open &&
      body >= 1.2 * prevBody && (c.high - c.close) / range >= 0.75) {
    out.push(M(i, "bearish_engulfing", "Bearish engulfing", "BE", "bearish"));
  }

  // --- Harami (inside body, prior body decisive)
  if (prevBody > 0 && body <= 0.6 * prevBody &&
      Math.max(c.open, c.close) <= Math.max(p.open, p.close) &&
      Math.min(c.open, c.close) >= Math.min(p.open, p.close) &&
      prevBody >= 0.5 * a) {
    if (p.close < p.open && green) out.push(M(i, "bullish_harami", "Bullish harami", "HA", "bullish"));
    else if (p.close > p.open && red) out.push(M(i, "bearish_harami", "Bearish harami", "HA", "bearish"));
  }

  // --- Piercing line / dark cloud cover
  const pMid = (p.open + p.close) / 2;
  if (p.close < p.open && green && c.open < p.close && c.close > pMid && c.close < p.open) {
    out.push(M(i, "piercing_line", "Piercing line", "PL", "bullish"));
  }
  if (p.close > p.open && red && c.open > p.close && c.close < pMid && c.close > p.open) {
    out.push(M(i, "dark_cloud", "Dark cloud cover", "DC", "bearish"));
  }

  // --- Morning / evening star (3 bars)
  if (p2) {
    const b2 = Math.abs(p2.close - p2.open);
    const b1 = Math.abs(p.close - p.open);
    const midP2 = (p2.open + p2.close) / 2;
    const smallMiddle = b1 <= 0.4 * b2 && b2 >= 0.5 * a;
    if (p2.close < p2.open && smallMiddle && green && c.close > midP2) {
      out.push(M(i, "morning_star", "Morning star", "MS", "bullish"));
    }
    if (p2.close > p2.open && smallMiddle && red && c.close < midP2) {
      out.push(M(i, "evening_star", "Evening star", "ES", "bearish"));
    }
    // --- Three white soldiers / three black crows
    const bars = [p2, p, c];
    const allGreen = bars.every((b) => b.close > b.open && (b.high - b.low) > 0 && Math.abs(b.close - b.open) / (b.high - b.low) >= 0.5);
    const allRed = bars.every((b) => b.close < b.open && (b.high - b.low) > 0 && Math.abs(b.close - b.open) / (b.high - b.low) >= 0.5);
    if (allGreen && p.close > p2.close && c.close > p.close) {
      out.push(M(i, "three_white_soldiers", "Three white soldiers", "3WS", "bullish"));
    }
    if (allRed && p.close < p2.close && c.close < p.close) {
      out.push(M(i, "three_black_crows", "Three black crows", "3BC", "bearish"));
    }
  }

  // --- Hammer family
  // The opposite wick must be small *relative to the range* — comparing it to
  // the body alone rejects textbook hammers whose body is itself tiny.
  const smallUpper = upper <= Math.max(body, 0.12 * range);
  const smallLower = lower <= Math.max(body, 0.12 * range);
  const longLower = lower > body * 2 && lower >= 0.5 * range && smallUpper;
  const longUpper = upper > body * 2 && upper >= 0.5 * range && smallLower;
  if (bodyRatio < 0.35 && longLower) {
    if (uptrend) out.push(M(i, "hanging_man", "Hanging man", "HM", "bearish"));
    else out.push(M(i, "hammer", "Hammer", "H", "bullish"));
  }
  if (bodyRatio < 0.35 && longUpper) {
    if (downtrend) out.push(M(i, "inverted_hammer", "Inverted hammer", "IH", "bullish"));
    else out.push(M(i, "shooting_star", "Shooting star", "SS", "bearish"));
  }

  // --- Doji family (needs real range, else every compressed bar qualifies)
  // A hammer/star already describes this bar better than "doji" would.
  if (range >= 0.5 * a && bodyRatio <= 0.1 && !longLower && !longUpper) {
    if (lower >= 2 * upper && lower >= 0.6 * range) out.push(M(i, "dragonfly_doji", "Dragonfly doji", "DD", "bullish"));
    else if (upper >= 2 * lower && upper >= 0.6 * range) out.push(M(i, "gravestone_doji", "Gravestone doji", "GD", "bearish"));
    else out.push(M(i, "doji", "Doji", "D", "neutral"));
  }

  // --- Tweezers
  const tol = 0.1 * a;
  if (Math.abs(c.low - p.low) <= tol && p.close < p.open && green && downtrend) {
    out.push(M(i, "tweezer_bottom", "Tweezer bottom", "TB", "bullish"));
  }
  if (Math.abs(c.high - p.high) <= tol && p.close > p.open && red && uptrend) {
    out.push(M(i, "tweezer_top", "Tweezer top", "TT", "bearish"));
  }

  out.push(...extraCandleMarksAt(candles, i, atr));
  return out.map((m) => enrichCandleMark(candles, atr, m));
}

/**
 * Attach the measured numbers behind a candlestick read plus its concrete
 * invalidation level, so the UI can *show* the rule instead of narrating it.
 * Detection thresholds are untouched — this only annotates.
 */
export function enrichCandleMark(candles: Candle[], atr: number | null, m: CandleMark): CandleMark {
  const i = m.index;
  const c = candles[i];
  if (!c) return m;
  const p = i >= 1 ? candles[i - 1] : null;
  const range = Math.max(1e-9, c.high - c.low);
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const a = atr && atr > 0 ? atr : range;
  const win = candles.slice(m.startIndex, m.endIndex + 1);
  const winHigh = Math.max(...win.map((x) => x.high));
  const winLow = Math.min(...win.map((x) => x.low));
  const prevBody = p ? Math.abs(p.close - p.open) : 0;
  const priorVols = candles.slice(Math.max(0, i - 20), i).map((x) => x.volume).filter((v) => v > 0);
  const avgVol = priorVols.length ? priorVols.reduce((s, v) => s + v, 0) / priorVols.length : 0;

  const evidence: Record<string, number> = {
    bars: m.endIndex - m.startIndex + 1,
    range,
    body,
    body_pct_of_range: (body / range) * 100,
    upper_wick_pct: (upperWick / range) * 100,
    lower_wick_pct: (lowerWick / range) * 100,
    close_pos_in_range_pct: ((c.close - c.low) / range) * 100,
    range_vs_atr: range / a,
    atr,
  } as Record<string, number>;
  if (!Number.isFinite(evidence.atr)) delete evidence.atr;
  if (prevBody > 0) evidence.body_vs_prev_body = body / prevBody;
  if (p) evidence.gap_pct = ((c.open - p.close) / Math.max(1e-9, p.close)) * 100;
  if (avgVol > 0) evidence.rel_volume = c.volume / avgVol;

  const bullish = m.tone === "bullish";
  const bearish = m.tone === "bearish";
  const invalidateLevel = bullish ? winLow : bearish ? winHigh : null;
  const invalidateText = invalidateLevel == null
    ? `Neutral read — a close outside ${winLow.toFixed(2)}–${winHigh.toFixed(2)} resolves it.`
    : `${bullish ? "Close below" : "Close above"} ${invalidateLevel.toFixed(2)} (pattern ${bullish ? "low" : "high"}) voids the read.`;
  const confirmText = invalidateLevel == null
    ? "A later close outside the pattern range confirms direction."
    : `${bullish ? "Close above" : "Close below"} ${(bullish ? winHigh : winLow).toFixed(2)} (pattern ${bullish ? "high" : "low"}) on the next bar confirms it.`;

  const measured = `Measured: body ${body.toFixed(2)} = ${(body / range * 100).toFixed(0)}% of range ${range.toFixed(2)}; upper wick ${(upperWick / range * 100).toFixed(0)}%, lower wick ${(lowerWick / range * 100).toFixed(0)}%; range ${(range / a).toFixed(2)}× ATR${prevBody > 0 ? `; body ${(body / prevBody).toFixed(2)}× prior body` : ""}${avgVol > 0 ? `; volume ${(c.volume / avgVol).toFixed(2)}× 20-bar avg` : ""}.`;
  return { ...m, evidence, invalidateLevel, invalidateText, confirmText, formula: `${m.formula} ${measured}` };
}


// ------------------------------------------------------ bearish structures
export function detectBearPatterns(candles: Candle[]): BearPatternFlags {
  const flags: BearPatternFlags = {
    double_top: false, head_shoulders: false, rising_wedge: false, descending_triangle: false,
  };
  const n = candles.length;
  if (n < 20) return flags;
  const c = candles[n - 1];
  const atrArr = atrSeries(candles);
  const atr = atrArr[n - 1] ?? Math.max(1e-6, c.high - c.low);

  // Descending triangle: flat bottom (3+ touches) under falling highs.
  if (n >= 25) {
    const w = candles.slice(-25);
    const lo = Math.min(...w.map((x) => x.low));
    const flatTol = Math.max(lo * 0.005, 0.5 * atr);
    const bottomTouches = w.filter((x) => x.low - lo <= flatTol).length;
    const bkt = [w.slice(0, 8), w.slice(8, 17), w.slice(17)];
    const maxes = bkt.map((b) => Math.max(...b.map((x) => x.high)));
    const fallingHighs = maxes[1] < maxes[0] * 0.995 && maxes[2] < maxes[1] * 0.995;
    flags.descending_triangle = bottomTouches >= 3 && fallingHighs;
  }

  // Double top: twin highs within 3%, a trough ≥5% below between them, price
  // back at/under the trough.
  if (n >= 40) {
    const w = candles.slice(-Math.min(80, n));
    const split = Math.floor(w.length * 0.55);
    const left = w.slice(0, split), right = w.slice(split);
    const iL = left.reduce((best, x, i) => x.high > left[best].high ? i : best, 0);
    const iR = right.reduce((best, x, i) => x.high > right[best].high ? i : best, 0);
    const hiL = left[iL].high, hiR = right[iR].high;
    const between = w.slice(iL + 1, split + iR);
    const trough = between.length ? Math.min(...between.map((x) => x.low)) : hiL;
    const sim = hiL > 0 ? Math.abs(hiL - hiR) / hiL : 1;
    const drop = Math.max(hiL, hiR) > 0 ? (Math.max(hiL, hiR) - trough) / Math.max(hiL, hiR) : 0;
    flags.double_top = sim <= 0.03 && drop >= 0.05 && c.close <= trough * 1.03;
  }

  // Head & shoulders: 3 peaks (L / H / R) with H the highest, shoulders within
  // 5%, close breaking the neckline (lowest low between the shoulders).
  if (n >= 50) {
    const w = candles.slice(-Math.min(90, n));
    const third = Math.floor(w.length / 3);
    const seg = [w.slice(0, third), w.slice(third, 2 * third), w.slice(2 * third)];
    const highs = seg.map((s) => Math.max(...s.map((x) => x.high)));
    const [hS, hH, rS] = highs;
    const shouldersClose = hS > 0 && Math.abs(hS - rS) / hS <= 0.05;
    const headTaller = hH > hS * 1.03 && hH > rS * 1.03;
    const neckline = Math.min(...w.slice(third).map((x) => x.low));
    flags.head_shoulders = shouldersClose && headTaller && c.close <= neckline * 1.02;
  }

  // Rising wedge: highs and lows both rising but converging, close breaking
  // the lower boundary.
  if (n >= 20) {
    const w = candles.slice(-20);
    const half = 10;
    const hi1 = Math.max(...w.slice(0, half).map((x) => x.high));
    const hi2 = Math.max(...w.slice(half).map((x) => x.high));
    const lo1 = Math.min(...w.slice(0, half).map((x) => x.low));
    const lo2 = Math.min(...w.slice(half).map((x) => x.low));
    const highsRise = hi2 > hi1 * 1.01;
    const lowsRise = lo2 > lo1;
    const converging = (hi1 - lo1) > (hi2 - lo2) * 1.10;
    flags.rising_wedge = highsRise && lowsRise && converging && c.close < lo2;
  }

  return flags;
}

/** Bullish + bearish structure flags for the last bar of `candles`. */
export function detectPatternsExtended(candles: Candle[]): ExtendedPatternFlags {
  return { ...detectPatterns(candles), ...detectBearPatterns(candles), ...structureFlags(candles) };
}

/** Same, evaluated at an arbitrary bar (trailing window only — no lookahead). */
export function detectPatternsAt(candles: Candle[], endIndex: number): ExtendedPatternFlags {
  const end = Math.min(endIndex, candles.length - 1);
  const start = Math.max(0, end - WINDOW + 1);
  return detectPatternsExtended(candles.slice(start, end + 1));
}

// ------------------------------------------------------------ shape scanner
interface ShapeMeta { label: string; tone: PatternTone; bars: number }
const SHAPE_META: Record<string, ShapeMeta> = {
  cup_and_handle: { label: "Cup & handle", tone: "bullish", bars: 90 },
  cup_and_handle_triggered: { label: "Cup & handle · triggered", tone: "bullish", bars: 90 },
  flag: { label: "Bull flag", tone: "bullish", bars: 15 },
  ascending_triangle: { label: "Ascending triangle", tone: "bullish", bars: 25 },
  double_bottom: { label: "Double bottom", tone: "bullish", bars: 80 },
  inverse_head_shoulders: { label: "Inv. head & shoulders", tone: "bullish", bars: 90 },
  falling_wedge: { label: "Falling wedge", tone: "bullish", bars: 20 },
  double_top: { label: "Double top", tone: "bearish", bars: 80 },
  head_shoulders: { label: "Head & shoulders", tone: "bearish", bars: 90 },
  rising_wedge: { label: "Rising wedge", tone: "bearish", bars: 20 },
  descending_triangle: { label: "Descending triangle", tone: "bearish", bars: 25 },
  // --- extended structures (pattern-structure.ts)
  triple_bottom: { label: "Triple bottom", tone: "bullish", bars: 90 },
  triple_top: { label: "Triple top", tone: "bearish", bars: 90 },
  rounded_bottom: { label: "Rounded bottom", tone: "bullish", bars: 40 },
  rounded_top: { label: "Rounded top", tone: "bearish", bars: 40 },
  inverse_cup_and_handle: { label: "Inverse cup & handle", tone: "bearish", bars: 50 },
  bear_flag: { label: "Bear flag", tone: "bearish", bars: 20 },
  bull_pennant: { label: "Bull pennant", tone: "bullish", bars: 20 },
  bear_pennant: { label: "Bear pennant", tone: "bearish", bars: 20 },
  symmetrical_triangle: { label: "Symmetrical triangle", tone: "neutral", bars: 25 },
  rectangle: { label: "Rectangle", tone: "neutral", bars: 25 },
  ascending_channel: { label: "Ascending channel", tone: "bullish", bars: 25 },
  descending_channel: { label: "Descending channel", tone: "bearish", bars: 25 },
  horizontal_channel: { label: "Horizontal channel", tone: "neutral", bars: 25 },
  broadening: { label: "Broadening formation", tone: "neutral", bars: 25 },
  wyckoff_accumulation: { label: "Wyckoff accumulation", tone: "bullish", bars: 20 },
  wyckoff_distribution: { label: "Wyckoff distribution", tone: "bearish", bars: 20 },
};
const SHAPE_KEYS = Object.keys(SHAPE_META);

function shapeEvidence(candles: Candle[], start: number, end: number, tone: PatternTone) {
  const win = candles.slice(start, end + 1);
  // Boundaries must come from bars BEFORE the evaluating/trigger candle.
  // Including the current high/low made a close beyond the boundary impossible.
  const base = candles.slice(start, Math.max(start + 1, end));
  const upper = base.length ? Math.max(...base.map((c) => c.high)) : null;
  const lower = base.length ? Math.min(...base.map((c) => c.low)) : null;
  const last = candles[end];
  const span = upper != null && lower != null ? Math.max(1e-9, upper - lower) : 0;
  const tolerance = Math.max(span * 0.08, (atrSeries(candles)[end] ?? 0) * 0.35);
  const upperTouches = upper == null ? 0 : win.filter((c) => upper - c.high <= tolerance).length;
  const lowerTouches = lower == null ? 0 : win.filter((c) => c.low - lower <= tolerance).length;
  const bullishTrigger = upper != null && last.close > upper + tolerance;
  const bearishTrigger = lower != null && last.close < lower - tolerance;
  const triggered = tone === "bullish" ? bullishTrigger : tone === "bearish" ? bearishTrigger : bullishTrigger || bearishTrigger;
  return { upper, lower, tolerance, upperTouches, lowerTouches, triggered };
}

/**
 * Full pattern scan over a candle array. `marks` are candlestick reads (one
 * per bar per pattern); `shapes` are multi-bar structures collapsed into a
 * single entry each with the window they formed over and their breakout level.
 */
export function detectPatternSeries(
  candles: Candle[],
  opts?: { minBars?: number; maxShapes?: number },
): PatternSeries {
  const n = candles.length;
  const marks: CandleMark[] = [];
  const shapes: ChartShape[] = [];
  if (n === 0) return { marks, shapes };

  const atrArr = atrSeries(candles);
  for (let i = 1; i < n; i++) marks.push(...candleMarksAt(candles, i, atrArr[i]));

  const minBars = opts?.minBars ?? 20;
  if (n < minBars) return { marks, shapes };

  // Track each structure's "on" run so a pattern that stays true for 12 bars
  // draws one shape, not twelve.
  const open = new Map<string, ChartShape>();
  for (let i = minBars; i < n; i++) {
    const flags = detectPatternsAt(candles, i) as unknown as Record<string, boolean>;
    // "triggered" is a state of cup_and_handle, not a separate structure.
    const triggeredNow = flags.cup_and_handle_triggered === true;
    for (const key of SHAPE_KEYS) {
      if (key === "cup_and_handle_triggered") continue;
      const meta = SHAPE_META[key];
      const on = flags[key] === true;
      const cur = open.get(key);
      if (on) {
        if (cur) {
          // A detector re-evaluates a trailing window. Do not let a loose flag
          // turn that local read into a hundreds-of-bars structure.
          if (i - cur.startIndex + 1 > meta.bars * 3) {
            open.delete(key);
            continue;
          }
          cur.endIndex = i;
          const ev = shapeEvidence(candles, cur.startIndex, i, meta.tone);
          const justTriggered = key === "cup_and_handle" ? triggeredNow : ev.triggered;
          if (justTriggered && !cur.triggered) {
            cur.triggered = true;
            cur.status = "triggered";
            cur.triggerIndex = i;
            cur.confidence = Math.min(95, cur.confidence + 15);
            if (key === "cup_and_handle") cur.label = SHAPE_META.cup_and_handle_triggered.label;
          }
        } else {
          const start = Math.max(0, i - meta.bars + 1);
          const ev = shapeEvidence(candles, start, i, meta.tone);
          const triggered = key === "cup_and_handle" ? triggeredNow : ev.triggered;
          const level = meta.tone === "bearish" ? ev.lower : ev.upper;
          const confidence = Math.min(95, 50 + Math.min(20, (ev.upperTouches + ev.lowerTouches) * 5) + (triggered ? 15 : 0));
          const shape: ChartShape = {
            key,
            label: key === "cup_and_handle" && triggeredNow ? SHAPE_META.cup_and_handle_triggered.label : meta.label,
            tone: meta.tone,
            startIndex: start,
            endIndex: i,
            level,
            triggered,
            status: triggered ? "triggered" : "forming",
            confidence,
            upper: ev.upper,
            lower: ev.lower,
            triggerIndex: triggered ? i : null,
            formula: `${i - start + 1}-bar structure; upper/lower tests ${ev.upperTouches}/${ev.lowerTouches}; tolerance ${ev.tolerance.toFixed(2)}.`,
            confirmText: ev.upper != null && ev.lower != null
              ? `Close ${meta.tone === "bearish" ? "below" : "above"} ${Number(meta.tone === "bearish" ? ev.lower : ev.upper).toFixed(2)} by more than ${ev.tolerance.toFixed(2)}`
              : "Await a completed close beyond the structure boundary.",
            invalidateText: ev.upper != null && ev.lower != null
              ? `${meta.tone === "bearish" ? "Close above" : "Close below"} ${Number(meta.tone === "bearish" ? ev.upper : ev.lower).toFixed(2)}`
              : "Opposite-boundary close.",
            evidence: {
              bars: i - start + 1,
              upper_touches: ev.upperTouches,
              lower_touches: ev.lowerTouches,
              tolerance: ev.tolerance,
            },
          };
          open.set(key, shape);
          shapes.push(shape);
        }
      } else if (cur) {
        open.delete(key);
      }
    }
  }

  const max = opts?.maxShapes ?? 40;
  return { marks, shapes: shapes.length > max ? shapes.slice(-max) : shapes };
}

// ------------------------------------------------------------ weekly bars
// Aggregate daily candles into ISO-week bars so the same detectors can give a
// higher-timeframe read (used for multi-timeframe pattern agreement).
export function toWeeklyCandles(daily: Candle[]): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curKey = "";
  for (const c of daily) {
    const d = new Date(c.time * 1000);
    // Monday-anchored bucket key.
    const day = (d.getUTCDay() + 6) % 7;
    const monday = Math.floor((c.time - day * 86400) / 86400);
    const key = String(monday);
    if (!cur || key !== curKey) {
      cur = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      curKey = key;
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  return out;
}

/** `{ w_hammer: true, ... }` — weekly flags namespaced for storage in pattern_flags. */
export function weeklyPatternFlags(daily: Candle[]): Record<string, boolean> {
  const w = detectPatternsExtended(toWeeklyCandles(daily)) as unknown as Record<string, boolean>;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(w)) if (v === true) out[`w_${k}`] = true;
  return out;
}
