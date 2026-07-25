// Breakout & pre-breakout scoring. Pure TS, zero Deno/npm imports — vitest-tested.
// Each scorer returns {score: 0-100, components} so the UI can explain itself.

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

export function breakoutScore(s: IndicatorSnapshot, ctx: MarketContext): ScoreResult {
  const c: Record<string, number> = {};

  // Volume spike (max 15): rel volume 1x → 0, 2x → 10, 3x+ → 15
  const rv = s.relVolume ?? 0;
  c.volume_spike = rv >= 2 ? clamp(10 + (rv - 2) * 5, 10, 15) : clamp((rv - 1) * 10, 0, 10);

  // Sustained relative volume (max 10)
  c.rel_volume = clamp((rv - 1) * 6.7, 0, 10);

  // Above EMA200 (10)
  c.above_ema200 = s.aboveEma200 ? 10 : 0;

  // EMA alignment 20>50>200 (10)
  c.ema_alignment = s.emaAligned ? 10 : 0;

  // RSI sweet spot 55–70 full marks, taper outside, overbought >80 = 0 (max 10)
  const rsi = s.rsi14;
  if (rsi == null) c.rsi = 0;
  else if (rsi >= 55 && rsi <= 70) c.rsi = 10;
  else if (rsi > 70 && rsi <= 80) c.rsi = 10 - (rsi - 70);
  else if (rsi >= 45 && rsi < 55) c.rsi = (rsi - 45);
  else c.rsi = 0;
  c.rsi = clamp(c.rsi, 0, 10);

  // MACD (max 10): bullish cross + rising histogram
  const macdBull = s.macd != null && s.macdSignal != null && s.macd > s.macdSignal;
  c.macd = (macdBull ? 6 : 0) + (s.macdHistRising ? 4 : 0);

  // Delivery % (max 5) — degrades to 0 when the data source lacks it
  const dp = ctx.deliveryPct;
  c.delivery = dp == null ? 0 : clamp(((dp - 30) / 30) * 5, 0, 5);

  // Proximity to 52w high (max 10): at high → 10, -15% → 0
  const pf = s.pctFrom52wHigh;
  c.near_52w_high = pf == null ? 0 : clamp(10 + (pf / 15) * 10, 0, 10);

  // Sector strength (max 10)
  c.sector_strength = ctx.sectorStrength == null ? 5 : clamp(ctx.sectorStrength * 10, 0, 10);

  // Market breadth regime (max 5)
  c.breadth = ctx.regime === "bullish" ? 5 : ctx.regime === "neutral" ? 2.5 : ctx.regime === "bearish" ? 0 : 2.5;

  // Relative strength vs NIFTY (max 5): +10% points over → full
  const rs = ctx.relStrengthNifty;
  c.rel_strength = rs == null ? 2.5 : clamp((rs / 10) * 5, 0, 5);

  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 10) / 10]));
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
