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
