// Breakout & pre-breakout scoring v2. Pure TS, zero Deno/npm imports —
// vitest-tested. Each scorer returns {score: 0-100, components} so the UI
// can explain itself. v2 replaces hard bands with graded curves, adds risk
// penalties (with a 0 floor), and drops the dubious 55–70 RSI sweet spot.

import type { IndicatorSnapshot } from "./indicators.ts";

export interface MarketContext {
  // 0..1 rank of the stock's sector for the day (1 = strongest); null when unknown
  sectorStrength: number | null;
  // breadth regime: 'bullish' | 'neutral' | 'bearish' | null
  regime: string | null;
  // stock return minus NIFTY return over ~55 sessions, in % points; null when unknown
  relStrengthNifty: number | null;
  deliveryPct: number | null;
}

export interface ScoreResult {
  score: number;
  components: Record<string, number>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// Smooth 0..1 ramp: below lo → 0, above hi → 1, linear between.
const ramp = (v: number, lo: number, hi: number) =>
  hi <= lo ? (v >= hi ? 1 : 0) : clamp((v - lo) / (hi - lo), 0, 1);

export function breakoutScore(s: IndicatorSnapshot, ctx: MarketContext): ScoreResult {
  const c: Record<string, number> = {};

  // --- Trigger & momentum (25) ---
  // Real breakout trigger = close above rolling N-day high, magnitude in ATRs.
  // Falls back to pctFrom52wHigh when rolling highs are unavailable.
  const pivot = s.rollingHigh20 ?? null;
  const atr = s.atr14 ?? null;
  if (pivot != null && s.close != null && atr != null && atr > 0) {
    const atrsAbove = (s.close - pivot) / atr;
    c.trigger = ramp(atrsAbove, 0, 1) * 10;
  } else {
    const pf = s.pctFrom52wHigh;
    c.trigger = pf == null ? 0 : ramp(pf, -15, 0) * 10;
  }
  // Close-in-range: at high of the day = full 3pts, at low = 0.
  const cir = s.closeInRangePct;
  c.close_in_range = cir == null ? 0 : ramp(cir, 40, 90) * 3;
  // Freshness: today's breakout > 3-day-old breakout > week-old. 0d=full, 5d+=0.
  const fresh = s.breakoutFreshnessDays;
  c.freshness = fresh == null ? 0 : Math.max(0, (1 - fresh / 5)) * 2;
  // ADX shows a real trend behind the move: 15 → 0, 30+ → full (max 5).
  c.adx = s.adx14 == null ? 0 : ramp(s.adx14, 15, 30) * 5;
  // MACD confirmation (bullish + rising hist).
  const macdBull = s.macd != null && s.macdSignal != null && s.macd > s.macdSignal;
  c.macd = (macdBull ? 3 : 0) + (s.macdHistRising ? 2 : 0);

  // --- Base quality (15) ---
  // Tight, shallow, mature bases break out cleaner. All optional.
  const bt = s.baseTightness;
  const bd = s.baseDepthPct;
  const bDur = s.baseDurationDays;
  c.base_tightness = bt == null ? 0 : (1 - ramp(bt, 0.02, 0.08)) * 6;   // ≤2%SD full, ≥8% none
  c.base_depth = bd == null ? 0 : (1 - ramp(bd, 8, 30)) * 5;             // ≤8% full, ≥30% none
  c.base_duration = bDur == null ? 0 : ramp(bDur, 10, 30) * 4;           // ≥30 sessions full

  // --- Volume/participation (20) ---
  const rv = s.relVolume ?? 0;
  c.volume = ramp(rv, 1, 3) * 10;
  const obv = s.obvSlope20 ?? null;
  c.obv = obv == null ? 0 : ramp(obv, 0, 1) * 4;
  const dp = ctx.deliveryPct;
  c.delivery = dp == null ? 0 : ramp(dp, 30, 70) * 6;

  // --- Trend (10) ---
  c.above_ema200 = s.aboveEma200 ? 5 : 0;
  c.ema_alignment = s.emaAligned ? 5 : 0;

  // --- Momentum (RSI) (5) --- graded, no dead band.
  const rsi = s.rsi14;
  let rsiScore = 0;
  if (rsi == null) rsiScore = 0;
  else if (rsi <= 45) rsiScore = 0;
  else if (rsi < 60) rsiScore = ((rsi - 45) / 15) * 5;
  else if (rsi <= 75) rsiScore = 5;
  else if (rsi < 85) rsiScore = ((85 - rsi) / 10) * 5;
  c.rsi = clamp(rsiScore, 0, 5);

  // --- RS & context (15) ---
  const rs = ctx.relStrengthNifty;
  c.rel_strength = rs == null ? 2 : ramp(rs, -5, 15) * 5;
  // RS percentile vs universe (0..100). Full at 90+, none at ≤50.
  const rsP = ctx.relStrengthNifty != null && s.rsPercentile == null ? null : s.rsPercentile;
  c.rs_percentile = rsP == null ? 0 : ramp(rsP, 50, 90) * 3;
  c.sector_strength = ctx.sectorStrength == null ? 2 : ctx.sectorStrength * 4;
  c.breadth = ctx.regime === "bullish" ? 3 : ctx.regime === "neutral" ? 1.5 : 0;

  // --- Risk penalties (subtract; floor 0) ---
  let penalty = 0;
  const penalties: Record<string, number> = {};
  if (s.atr14 != null && s.atr14 > 0 && s.ema20 != null && s.close != null) {
    const atrsAboveEma = (s.close - s.ema20) / s.atr14;
    const p = ramp(atrsAboveEma, 3, 6) * 15;
    if (p > 0) { penalties.overextension = p; penalty += p; }
  }
  if (rv > 0 && rv < 0.8) {
    const p = (0.8 - rv) * 10;
    penalties.thin_volume = p; penalty += p;
  }

  const gross = Object.values(c).reduce((a, b) => a + b, 0);
  let total = gross - penalty;
  const regimeMult = ctx.regime === "bullish" ? 1.05 : ctx.regime === "bearish" ? 0.7 : 1;
  total *= regimeMult;
  const components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  for (const [k, v] of Object.entries(penalties)) components[`penalty_${k}`] = -Math.round(v * 10) / 10;
  components.regime_mult = Math.round(regimeMult * 100) / 100;
  return { score: Math.round(clamp(total, 0, 100)), components };
}

export function preBreakoutScore(s: IndicatorSnapshot, ctx: MarketContext): ScoreResult {
  const c: Record<string, number> = {};

  // Bollinger squeeze (25)
  c.bb_squeeze = s.bbSqueeze ? 25 : 0;

  // ATR contraction (15)
  c.atr_contraction = s.atrContracting ? 15 : 0;

  // Higher lows (20)
  c.higher_lows = s.higherLows ? 20 : 0;

  // Within 3% below resistance (20)
  c.near_resistance = s.nearResistance ? 20 : 0;

  // Quiet volume during base: rel volume 0.5–1.1 is constructive (max 10)
  const rv = s.relVolume;
  c.quiet_volume = rv != null && rv >= 0.4 && rv <= 1.15 ? 10 : 0;

  // Trend filter: above 200 EMA adds conviction (10)
  c.above_ema200 = s.aboveEma200 ? 10 : 0;

  let total = Object.values(c).reduce((a, b) => a + b, 0);
  // Bearish regime dampens expectations
  if (ctx.regime === "bearish") total *= 0.7;

  const components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  return { score: Math.round(clamp(total, 0, 100)), components };
}

export function classifyRegime(pctAboveEma50: number | null, avgRsi: number | null): string {
  if (pctAboveEma50 == null || avgRsi == null) return "neutral";
  if (pctAboveEma50 >= 60 && avgRsi >= 55) return "bullish";
  if (pctAboveEma50 <= 35 || avgRsi <= 42) return "bearish";
  return "neutral";
}

// ============================================================================
// v3 — intraday & swing scoring, additive. breakoutScore/preBreakoutScore
// above are UNCHANGED (byte-for-byte) so every existing consumer (AutoTrade
// entry/exit conditions, market-alerts-eval's `?? 70` fallback, the nightly
// AI prompt's hardcoded 70/55/40 band, Dashboard's >=70/<40 buckets,
// ScoreBadge's color ramp) keeps behaving exactly as it does today. New
// scores land in new columns; nothing here overwrites the live
// breakout_score/prebreakout_score values.
//
// Known issues in the v2 functions above, deliberately NOT fixed in place
// (fixing them would change the live score for every existing consumer —
// see the safety note above) — instead corrected here in v3:
//   - `rs_percentile`'s guard ternary (line ~90) is a no-op; functionally
//     just `s.rsPercentile`. v3 computes it directly, no dead conditional.
//   - preBreakoutScore's quiet_volume comment claims a 0.5–1.1 band; the
//     code actually checks 0.4–1.15. v3's equivalent factor documents the
//     band it actually uses.
//   - breakoutScore's `delivery` component (max 6pts) always contributes 0
//     — `deliveryPct` is hardcoded null at both pipeline call sites, and
//     wiring real delivery% would need a new NSE "security-wise delivery
//     position" report ingestion (a separate file from the bhavcopy this
//     codebase already syncs) — out of scope here. v3 has no delivery
//     component; its weight is folded into volume/participation instead.
// ============================================================================

import type { WeeklySnapshot } from "./indicators.ts";

// ---- Liquidity / penny-stock gate ----
// No liquidity floor exists anywhere in the pipeline today — any active NSE
// symbol gets scored regardless of price or turnover. These are the hard
// defaults for the new scores; tune here (single source of truth).
export const LIQUIDITY_MIN_PRICE = 20;            // ₹ — excludes true penny stocks
export const LIQUIDITY_MIN_MARKET_CAP_CR = 100;    // ₹ Cr
export const LIQUIDITY_MIN_TURNOVER_CR = 1;        // ₹ Cr/day, 20D avg volume × price — price-aware, unlike raw share-count volume

export interface LiquidityInput {
  close: number | null;
  marketCapCr: number | null;
  avgTurnoverCr: number | null;
}
export interface LiquidityGate {
  ok: boolean;
  reasons: string[];
}
export function evaluateLiquidity(input: LiquidityInput): LiquidityGate {
  const reasons: string[] = [];
  if (input.close == null || input.close < LIQUIDITY_MIN_PRICE) reasons.push(`price below ₹${LIQUIDITY_MIN_PRICE}`);
  if (input.marketCapCr == null || input.marketCapCr < LIQUIDITY_MIN_MARKET_CAP_CR) reasons.push(`market cap below ₹${LIQUIDITY_MIN_MARKET_CAP_CR}Cr`);
  if (input.avgTurnoverCr == null || input.avgTurnoverCr < LIQUIDITY_MIN_TURNOVER_CR) reasons.push(`avg turnover below ₹${LIQUIDITY_MIN_TURNOVER_CR}Cr/day`);
  return { ok: reasons.length === 0, reasons };
}

export interface ScoreResultV3 extends ScoreResult {
  liquidityOk: boolean;
  liquidityReasons: string[];
}
const gated = (reasons: string[]): ScoreResultV3 => ({
  score: 0, components: {}, liquidityOk: false, liquidityReasons: reasons,
});

// Candlestick/chart-pattern flags + VWAP/Supertrend/MFI/%B — all already
// computed by indicators-advanced.ts but never wired to anything until now.
export interface AdvancedSignals {
  vwapRel: number | null;        // (close - vwap) / vwap, as a fraction (e.g. 0.02 = 2% above VWAP)
  supertrendDir: 1 | -1 | null;
  mfi14: number | null;
  percentB: number | null;
  patterns: {
    bullishEngulfing: boolean; hammer: boolean; doji: boolean;
    cupAndHandle: boolean; flag: boolean; ascendingTriangle: boolean;
    bearishEngulfing: boolean; shootingStar: boolean;
  };
}
const EMPTY_PATTERNS: AdvancedSignals["patterns"] = {
  bullishEngulfing: false, hammer: false, doji: false,
  cupAndHandle: false, flag: false, ascendingTriangle: false,
  bearishEngulfing: false, shootingStar: false,
};

// Bullish continuation/reversal patterns near a level, small weighted bonus
// (max `cap` points). Shared by both v3 scorers.
function patternBonus(p: AdvancedSignals["patterns"] | undefined, cap: number): number {
  if (!p) return 0;
  let pts = 0;
  if (p.cupAndHandle) pts += 0.4;
  if (p.ascendingTriangle) pts += 0.3;
  if (p.flag) pts += 0.2;
  if (p.bullishEngulfing) pts += 0.2;
  if (p.hammer) pts += 0.15;
  if (p.bearishEngulfing) pts -= 0.2;
  if (p.shootingStar) pts -= 0.15;
  return clamp(pts, 0, 1) * cap;
}

export interface SwingInput {
  s: IndicatorSnapshotLike;
  ctx: MarketContext;
  weekly: WeeklySnapshot | null;
  adv?: AdvancedSignals;
  liquidity: LiquidityGate;
}

// Structural subset of IndicatorSnapshot this file needs — avoids a hard
// dependency on the full interface shape for callers building a partial one.
export interface IndicatorSnapshotLike {
  close: number | null;
  rollingHigh20?: number | null;
  atr14: number | null;
  ema20: number | null;
  adx14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistRising: boolean;
  relVolume: number | null;
  obvSlope20?: number | null;
  baseTightness?: number | null;
  baseDepthPct?: number | null;
  baseDurationDays?: number | null;
  emaAligned: boolean;
  aboveEma200: boolean;
  pctFrom52wHigh: number | null;
  supportTouches?: number;
  resistanceTouches?: number;
  rsi14: number | null;
  rsPercentile?: number | null;
}

// Swing-trade composite (nominal ceiling 100 before regime mult): same
// factor library as breakoutScore, reweighted toward multi-session/weekly
// confirmation over single-day volume spikes. Liquidity-gated — a stock
// failing evaluateLiquidity() scores 0 with the reasons surfaced, never
// silently included with a misleadingly-normal-looking number.
export function swingScore(input: SwingInput): ScoreResultV3 {
  const { s, ctx, weekly, adv, liquidity } = input;
  if (!liquidity.ok) return gated(liquidity.reasons);
  const c: Record<string, number> = {};

  // --- Weekly trend confirmation (20) — new, zero new infra ---
  if (weekly) {
    c.weekly_trend = (weekly.aboveEma20W ? 10 : 0) + (weekly.trendUpW ? 5 : 0);
    c.weekly_higher_lows = weekly.higherLowsW ? 5 : 0;
  } else {
    c.weekly_trend = 0; c.weekly_higher_lows = 0;
  }

  // --- Base quality + daily trend (25) ---
  const bt = s.baseTightness, bd = s.baseDepthPct, bDur = s.baseDurationDays;
  c.base_tightness = bt == null ? 0 : (1 - ramp(bt, 0.02, 0.08)) * 8;
  c.base_depth = bd == null ? 0 : (1 - ramp(bd, 8, 30)) * 7;
  c.base_duration = bDur == null ? 0 : ramp(bDur, 10, 30) * 5;
  c.ema_alignment = (s.emaAligned ? 3 : 0) + (s.aboveEma200 ? 2 : 0);

  // --- Trigger/momentum (20) ---
  const pivot = s.rollingHigh20 ?? null;
  const atr = s.atr14;
  if (pivot != null && s.close != null && atr != null && atr > 0) {
    c.trigger = ramp((s.close - pivot) / atr, 0, 1) * 10;
  } else {
    c.trigger = s.pctFrom52wHigh == null ? 0 : ramp(s.pctFrom52wHigh, -15, 0) * 10;
  }
  c.adx = s.adx14 == null ? 0 : ramp(s.adx14, 15, 30) * 5;
  const macdBull = s.macd != null && s.macdSignal != null && s.macd > s.macdSignal;
  c.macd = (macdBull ? 3 : 0) + (s.macdHistRising ? 2 : 0);

  // --- RS & sector (20) ---
  // v2's `rs_percentile` line was a no-op ternary (functionally just
  // `s.rsPercentile` regardless of the guard) — computed directly here.
  const rs = ctx.relStrengthNifty;
  c.rel_strength = rs == null ? 2 : ramp(rs, -5, 15) * 6;
  c.rs_percentile = s.rsPercentile == null ? 0 : ramp(s.rsPercentile, 50, 90) * 4;
  c.sector_strength = ctx.sectorStrength == null ? 2 : ctx.sectorStrength * 4;
  c.breadth = ctx.regime === "bullish" ? 6 : ctx.regime === "neutral" ? 3 : 0;

  // --- Pattern/advanced bonus (15) ---
  c.patterns = patternBonus(adv?.patterns, 10);
  if (adv?.supertrendDir === 1) c.supertrend = 3;
  if (adv?.vwapRel != null && adv.vwapRel > 0) c.vwap = Math.min(2, ramp(adv.vwapRel, 0, 0.03) * 2);

  // --- Risk penalty (same shape as breakoutScore's overextension) ---
  let penalty = 0;
  const penalties: Record<string, number> = {};
  if (s.atr14 != null && s.atr14 > 0 && s.ema20 != null && s.close != null) {
    const p = ramp((s.close - s.ema20) / s.atr14, 3, 6) * 15;
    if (p > 0) { penalties.overextension = p; penalty += p; }
  }

  const gross = Object.values(c).reduce((a, b) => a + b, 0);
  let total = gross - penalty;
  const regimeMult = ctx.regime === "bullish" ? 1.05 : ctx.regime === "bearish" ? 0.7 : 1;
  total *= regimeMult;
  const components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  for (const [k, v] of Object.entries(penalties)) components[`penalty_${k}`] = -Math.round(v * 10) / 10;
  components.regime_mult = Math.round(regimeMult * 100) / 100;
  return { score: Math.round(clamp(total, 0, 100)), components, liquidityOk: true, liquidityReasons: [] };
}

export interface IntradayInput {
  s: IndicatorSnapshotLike;
  ctx: MarketContext;
  adv?: AdvancedSignals;
  liquidity: LiquidityGate;
  // Time-of-day-normalized: today's cumulative volume so far ÷ the SAME
  // time-of-day cumulative volume on the last session — not a full-day
  // average, which always makes an in-progress session look artificially
  // thin. Null outside market hours / before this is computed.
  relVolumeSoFar: number | null;
  gapPct: number | null; // (todayOpen - prevClose) / prevClose * 100
}

// Intraday composite (nominal ceiling 100 before regime mult): weighted
// toward same-session conviction (time-of-day-normalized volume, gap,
// momentum, proximity to the pivot) rather than multi-week structure —
// de-emphasizes weekly trend/base quality, which are close to irrelevant
// for a trade meant to close by end of day. Liquidity-gated, same as swing.
export function intradayScore(input: IntradayInput): ScoreResultV3 {
  const { s, ctx, adv, liquidity, relVolumeSoFar, gapPct } = input;
  if (!liquidity.ok) return gated(liquidity.reasons);
  const c: Record<string, number> = {};

  // --- Same-session volume/conviction (35) ---
  const rv = relVolumeSoFar ?? s.relVolume ?? 0;
  c.volume_surge = ramp(rv, 1, 3) * 20;
  c.obv = s.obvSlope20 == null ? 0 : ramp(s.obvSlope20, 0, 1) * 5;
  c.mfi = adv?.mfi14 == null ? 0 : ramp(adv.mfi14, 50, 80) * 10;

  // --- Momentum/trigger (30) ---
  const pivot = s.rollingHigh20 ?? null;
  const atr = s.atr14;
  if (pivot != null && s.close != null && atr != null && atr > 0) {
    c.trigger = ramp((s.close - pivot) / atr, 0, 1) * 15;
  } else if (adv?.vwapRel != null) {
    c.trigger = ramp(adv.vwapRel, 0, 0.02) * 15;
  } else {
    c.trigger = 0;
  }
  c.adx = s.adx14 == null ? 0 : ramp(s.adx14, 15, 30) * 5;
  const macdBull = s.macd != null && s.macdSignal != null && s.macd > s.macdSignal;
  c.macd = (macdBull ? 3 : 0) + (s.macdHistRising ? 2 : 0);
  const rsi = s.rsi14;
  c.rsi = rsi == null ? 0 : rsi <= 45 ? 0 : rsi < 60 ? ((rsi - 45) / 15) * 5 : rsi <= 75 ? 5 : rsi < 85 ? ((85 - rsi) / 10) * 5 : 0;

  // --- Gap + Supertrend/VWAP alignment (20) ---
  c.gap = gapPct == null ? 0 : ramp(Math.abs(gapPct), 0.5, 3) * 10;
  if (adv?.supertrendDir === 1) c.supertrend = 5;
  if (adv?.vwapRel != null && adv.vwapRel > 0) c.vwap = 5;

  // --- Pattern bonus (15) ---
  c.patterns = patternBonus(adv?.patterns, 15);

  // --- Risk penalty ---
  let penalty = 0;
  const penalties: Record<string, number> = {};
  if (s.atr14 != null && s.atr14 > 0 && s.ema20 != null && s.close != null) {
    const p = ramp((s.close - s.ema20) / s.atr14, 3, 6) * 15;
    if (p > 0) { penalties.overextension = p; penalty += p; }
  }
  if (rv > 0 && rv < 0.8) {
    const p = (0.8 - rv) * 10;
    penalties.thin_volume = p; penalty += p;
  }

  const gross = Object.values(c).reduce((a, b) => a + b, 0);
  let total = gross - penalty;
  const regimeMult = ctx.regime === "bullish" ? 1.05 : ctx.regime === "bearish" ? 0.7 : 1;
  total *= regimeMult;
  const components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  for (const [k, v] of Object.entries(penalties)) components[`penalty_${k}`] = -Math.round(v * 10) / 10;
  components.regime_mult = Math.round(regimeMult * 100) / 100;
  return { score: Math.round(clamp(total, 0, 100)), components, liquidityOk: true, liquidityReasons: [] };
}
