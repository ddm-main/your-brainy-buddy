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
  // v2: real breakout trigger = close above a rolling N-day high, magnitude in
  // ATR units. Falls back to pctFrom52wHigh when rolling highs are unavailable
  // (older pipeline snapshots) so the scorer degrades gracefully rather than
  // going silent.
  const pivot = s.rollingHigh20 ?? null;
  const atr = s.atr14 ?? null;
  if (pivot != null && s.close != null && atr != null && atr > 0) {
    // (close − pivot) in ATRs. 0 = at pivot, 1 = classic breakout, 2+ = strong.
    const atrsAbove = (s.close - pivot) / atr;
    // 0 → 0, 0.05 → 6 (fresh close-above), 1.0 → 15 (full).
    c.trigger = ramp(atrsAbove, 0, 1) * 15;
  } else {
    // Fallback: proximity to 52w high. At high → full; −15% → 0.
    const pf = s.pctFrom52wHigh;
    c.trigger = pf == null ? 0 : ramp(pf, -15, 0) * 15;
  }
  // ADX shows a real trend behind the move: 15 → 0, 30+ → full (max 5).
  c.adx = s.adx14 == null ? 0 : ramp(s.adx14, 15, 30) * 5;
  // MACD confirmation (bullish + rising hist).
  const macdBull = s.macd != null && s.macdSignal != null && s.macd > s.macdSignal;
  c.macd = (macdBull ? 3 : 0) + (s.macdHistRising ? 2 : 0);

  // --- Volume/participation (20) ---
  const rv = s.relVolume ?? 0;
  // Graded: 1.0× → 0, 3.0× → full. Beyond 3× keeps the max (no bonus for spikes).
  c.volume = ramp(rv, 1, 3) * 10;
  // OBV slope over ~20 sessions confirms accumulation (max 4). Null → 0.
  const obv = s.obvSlope20 ?? null;
  c.obv = obv == null ? 0 : ramp(obv, 0, 1) * 4;
  // Delivery % — graded 30 → 70. Missing degrades to 0 (unchanged behaviour).
  const dp = ctx.deliveryPct;
  c.delivery = dp == null ? 0 : ramp(dp, 30, 70) * 6;

  // --- Trend (20) ---
  c.above_ema200 = s.aboveEma200 ? 10 : 0;
  c.ema_alignment = s.emaAligned ? 10 : 0;

  // --- Momentum (RSI) (10) --- graded, no dead band.
  // 45 → 0, 60 → full, 75 → full, 85 → 0 (overbought is bad again).
  const rsi = s.rsi14;
  if (rsi == null) c.rsi = 0;
  else if (rsi <= 45) c.rsi = 0;
  else if (rsi < 60) c.rsi = ((rsi - 45) / 15) * 10;
  else if (rsi <= 75) c.rsi = 10;
  else if (rsi < 85) c.rsi = ((85 - rsi) / 10) * 10;
  else c.rsi = 0;
  c.rsi = clamp(c.rsi, 0, 10);

  // --- RS & context (15) ---
  const rs = ctx.relStrengthNifty;
  c.rel_strength = rs == null ? 3 : ramp(rs, -5, 15) * 8;
  c.sector_strength = ctx.sectorStrength == null ? 2 : ctx.sectorStrength * 4;
  c.breadth = ctx.regime === "bullish" ? 3 : ctx.regime === "neutral" ? 1.5 : 0;

  // --- Risk penalties (subtract; floor 0) ---
  // Over-extension in ATR: close > EMA20 by many ATRs → chase-trap.
  let penalty = 0;
  const penalties: Record<string, number> = {};
  if (s.atr14 != null && s.atr14 > 0 && s.ema20 != null && s.close != null) {
    const atrsAboveEma = (s.close - s.ema20) / s.atr14;
    const p = ramp(atrsAboveEma, 3, 6) * 15; // 3 ATRs → 0, 6+ ATRs → -15
    if (p > 0) { penalties.overextension = p; penalty += p; }
  }
  // Thin liquidity: sub-1× volume during a "breakout" isn't a breakout.
  if (rv > 0 && rv < 0.8) {
    const p = (0.8 - rv) * 10; // up to -8
    penalties.thin_volume = p; penalty += p;
  }

  const gross = Object.values(c).reduce((a, b) => a + b, 0);
  let total = gross - penalty;
  // v2: apply regime multiplier to breakout score (preBreakout already does).
  // Bullish tape amplifies, bearish tape dampens. Same 0.7× floor as preBreakout.
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
