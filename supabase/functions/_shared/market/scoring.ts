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

// OBV slope is *normalized* (slope per bar ÷ mean OBV), so its live range is
// tiny: across the NSE universe p50 ≈ 0.0003 and p90 ≈ 0.019. The original
// ramp(obv, 0, 1) therefore scored ~0 for every stock on earth, silently
// removing 6 (breakout) / 5 (intraday) points from the achievable ceiling —
// one of the reasons nothing ever crossed the 70 "strong" band. Full credit
// now lands at the universe's ~p90 accumulation slope.
export const OBV_SLOPE_FULL = 0.02;
// v4 keeps its own OBV normalisation constant so tuning the v4 volume bucket
// can't silently move every legacy v2 score (and its stored history).
export const V4_OBV_SLOPE_FULL = 0.02;
// Realistically reachable bull-pattern bonus. breakoutPatternBonus caps at 8,
// but that requires nearly every detector firing at once; normalising against
// the theoretical cap made the 11-point bucket unreachable in practice.
export const V4_PATTERN_BONUS_FULL = 6;

// Optional pattern + level context — passed through by the pipeline / live
// recompute so the breakout scorer can reward chart patterns when they print
// AT the right level (hammer at support, cup&handle triggered above the
// right rim, ascending triangle while nearResistance) and penalise bearish
// reversals at resistance. Passing nothing → all pattern bonuses are 0, so
// legacy call sites keep working byte-identically.
export interface BreakoutPatterns {
  bullishEngulfing?: boolean;
  bearishEngulfing?: boolean;
  hammer?: boolean;
  shootingStar?: boolean;
  doji?: boolean;
  cupAndHandle?: boolean;
  cupAndHandleTriggered?: boolean;
  flag?: boolean;
  ascendingTriangle?: boolean;
  doubleBottom?: boolean;
  inverseHeadShoulders?: boolean;
  fallingWedge?: boolean;
  // Bearish structures (pattern-series.ts). Optional — omitted by legacy
  // callers, in which case they contribute nothing.
  doubleTop?: boolean;
  headShoulders?: boolean;
  risingWedge?: boolean;
  descendingTriangle?: boolean;
  // Extended structures + confirmations (pattern-structure.ts). All optional:
  // legacy callers omit them and score byte-identically.
  tripleBottom?: boolean;
  tripleTop?: boolean;
  roundedBottom?: boolean;
  roundedTop?: boolean;
  inverseCupAndHandle?: boolean;
  bullPennant?: boolean;
  bearFlag?: boolean;
  bearPennant?: boolean;
  ascendingChannel?: boolean;
  descendingChannel?: boolean;
  breakawayGap?: boolean;
  exhaustionGap?: boolean;
  volumeBreakout?: boolean;
  volumeClimax?: boolean;
  accumulation?: boolean;
  distribution?: boolean;
  wyckoffSpring?: boolean;
  wyckoffUpthrust?: boolean;
  goldenCross?: boolean;
  deathCross?: boolean;
  supportBounce?: boolean;
  resistanceRejection?: boolean;
  bosUp?: boolean;
  bosDown?: boolean;
  chochUp?: boolean;
  chochDown?: boolean;
}

/** Map a `pattern_flags` JSON map (snake_case keys) onto scorer inputs. */
export function patternsFromFlags(f: Record<string, boolean> | null | undefined, prefix = ""): BreakoutPatterns {
  const g = (k: string) => f?.[`${prefix}${k}`] === true;
  return {
    bullishEngulfing: g("bullish_engulfing"), bearishEngulfing: g("bearish_engulfing"),
    hammer: g("hammer"), shootingStar: g("shooting_star"), doji: g("doji"),
    cupAndHandle: g("cup_and_handle"), cupAndHandleTriggered: g("cup_and_handle_triggered"),
    flag: g("flag"), ascendingTriangle: g("ascending_triangle"), doubleBottom: g("double_bottom"),
    inverseHeadShoulders: g("inverse_head_shoulders"), fallingWedge: g("falling_wedge"),
    doubleTop: g("double_top"), headShoulders: g("head_shoulders"), risingWedge: g("rising_wedge"),
    descendingTriangle: g("descending_triangle"),
    tripleBottom: g("triple_bottom"), tripleTop: g("triple_top"),
    roundedBottom: g("rounded_bottom"), roundedTop: g("rounded_top"),
    inverseCupAndHandle: g("inverse_cup_and_handle"),
    bullPennant: g("bull_pennant"), bearFlag: g("bear_flag"), bearPennant: g("bear_pennant"),
    ascendingChannel: g("ascending_channel"), descendingChannel: g("descending_channel"),
    breakawayGap: g("breakaway_gap"), exhaustionGap: g("exhaustion_gap"),
    volumeBreakout: g("volume_breakout"), volumeClimax: g("volume_climax"),
    accumulation: g("accumulation"), distribution: g("distribution"),
    wyckoffSpring: g("wyckoff_spring"), wyckoffUpthrust: g("wyckoff_upthrust"),
    goldenCross: g("golden_cross"), deathCross: g("death_cross"),
    supportBounce: g("support_bounce"), resistanceRejection: g("resistance_rejection"),
    bosUp: g("bos_up"), bosDown: g("bos_down"), chochUp: g("choch_up"), chochDown: g("choch_down"),
  };
}

/** True when any bullish structure is set — used for multi-timeframe agreement. */
export function hasBullStructure(p: BreakoutPatterns | null | undefined): boolean {
  if (!p) return false;
  return !!(p.cupAndHandle || p.cupAndHandleTriggered || p.ascendingTriangle || p.flag ||
    p.doubleBottom || p.inverseHeadShoulders || p.fallingWedge ||
    p.tripleBottom || p.roundedBottom || p.bullPennant || p.ascendingChannel);
}

// Context-aware pattern read used by breakoutScore. Returns two numbers so
// the caller can surface them separately in the UI (positives are in the
// `pattern` component; negatives land under `penalty_bearish_pattern`).
export function breakoutPatternBonus(
  p: BreakoutPatterns | undefined,
  nearR: boolean,
  atSupport: boolean,
  higherLows: boolean,
): { bonus: number; penalty: number; labels: string[] } {
  if (!p) return { bonus: 0, penalty: 0, labels: [] };
  let bonus = 0, penalty = 0;
  const labels: string[] = [];
  // Cup&handle: full when the right rim has been cleared, half while forming.
  if (p.cupAndHandleTriggered) { bonus += 4; labels.push("cup & handle · triggered"); }
  else if (p.cupAndHandle) { bonus += 2; labels.push("cup & handle · forming"); }
  // Ascending triangle only pays out into an actual ceiling.
  if (p.ascendingTriangle) { bonus += nearR ? 3 : 1; labels.push("ascending triangle"); }
  // Flag pays out on an ongoing higher-lows trend (continuation setup).
  if (p.flag) { bonus += higherLows ? 2 : 1; labels.push("bull flag"); }
  // Bullish engulfing / hammer are level-anchored: full at support, half elsewhere.
  if (p.bullishEngulfing) { bonus += atSupport ? 2 : 1; labels.push("bullish engulfing"); }
  if (p.hammer) { bonus += atSupport ? 2 : 1; labels.push("hammer"); }
  if (p.doubleBottom) { bonus += 2; labels.push("double bottom"); }
  if (p.inverseHeadShoulders) { bonus += 2; labels.push("inv. head & shoulders"); }
  if (p.fallingWedge) { bonus += 1; labels.push("falling wedge"); }
  // Extended bullish structures.
  if (p.tripleBottom) { bonus += 2; labels.push("triple bottom"); }
  if (p.roundedBottom) { bonus += 1.5; labels.push("rounded bottom"); }
  if (p.bullPennant) { bonus += higherLows ? 2 : 1; labels.push("bull pennant"); }
  if (p.ascendingChannel) { bonus += 1; labels.push("ascending channel"); }
  if (p.breakawayGap) { bonus += 1.5; labels.push("breakaway gap"); }
  if (p.supportBounce) { bonus += atSupport ? 1.5 : 0.5; labels.push("support bounce"); }
  if (p.goldenCross) { bonus += 1.5; labels.push("golden cross"); }
  if (p.wyckoffSpring) { bonus += 1.5; labels.push("wyckoff spring"); }
  // Bearish patterns: full penalty at resistance, half elsewhere.
  if (p.bearishEngulfing) { penalty += nearR ? 3 : 1.5; labels.push("bearish engulfing"); }
  if (p.shootingStar) { penalty += nearR ? 3 : 1.5; labels.push("shooting star"); }
  // Bearish structures: distribution tops outweigh single-bar reversals.
  if (p.headShoulders) { penalty += 3; labels.push("head & shoulders"); }
  if (p.doubleTop) { penalty += 2.5; labels.push("double top"); }
  if (p.descendingTriangle) { penalty += 2; labels.push("descending triangle"); }
  if (p.risingWedge) { penalty += 2; labels.push("rising wedge"); }
  // Extended bearish structures / distribution reads.
  if (p.tripleTop) { penalty += 2.5; labels.push("triple top"); }
  if (p.roundedTop) { penalty += 1.5; labels.push("rounded top"); }
  if (p.inverseCupAndHandle) { penalty += 2; labels.push("inverse cup & handle"); }
  if (p.bearFlag) { penalty += 1.5; labels.push("bear flag"); }
  if (p.bearPennant) { penalty += 1.5; labels.push("bear pennant"); }
  if (p.descendingChannel) { penalty += 1; labels.push("descending channel"); }
  if (p.distribution) { penalty += 1.5; labels.push("distribution"); }
  if (p.wyckoffUpthrust) { penalty += 1.5; labels.push("wyckoff upthrust"); }
  if (p.deathCross) { penalty += 1.5; labels.push("death cross"); }
  if (p.exhaustionGap) { penalty += 1; labels.push("exhaustion gap"); }
  if (p.resistanceRejection) { penalty += nearR ? 1.5 : 0.5; labels.push("resistance rejection"); }
  // Confirmation multipliers — market structure and volume do not add weight of
  // their own, they amplify or damp whatever structure is already there.
  const confirmUp = (p.bosUp ? 1 : 0) + (p.chochUp ? 1 : 0) + (p.volumeBreakout ? 1 : 0) + (p.accumulation ? 1 : 0);
  const confirmDown = (p.bosDown ? 1 : 0) + (p.chochDown ? 1 : 0) + (p.volumeClimax ? 1 : 0) + (p.distribution ? 1 : 0);
  if (bonus > 0 && confirmUp > 0) {
    bonus *= 1 + Math.min(0.3, 0.1 * confirmUp);
    labels.push("structure confirmed");
  }
  if (bonus > 0 && confirmDown > 0) bonus *= 1 - Math.min(0.3, 0.1 * confirmDown);
  if (penalty > 0 && confirmDown > 0) penalty *= 1 + Math.min(0.3, 0.1 * confirmDown);
  // Cap the pattern bucket so a stock with every bull pattern set doesn't
  // outweigh trigger + volume.
  bonus = clamp(bonus, 0, 8);
  penalty = clamp(penalty, 0, 5);
  return { bonus, penalty, labels };
}

export function breakoutScore(
  s: IndicatorSnapshot,
  ctx: MarketContext,
  patterns?: BreakoutPatterns,
): ScoreResult {
  const c: Record<string, number> = {};

  // --- Trigger & momentum (25) ---
  // Real breakout trigger = close above the base pivot, magnitude in ATRs.
  // The pivot is the strongest CLUSTERED swing-high level price has cleared
  // (a ceiling touched 3+ times is a real base; a rolling-20 high can be one
  // spike bar). We take whichever of the two is higher so a genuine new high
  // is never scored against a stale cluster, and scale the trigger by pivot
  // quality: a 1-touch level earns 80% of the points, 3+ touches earn 100%.
  const clusterPivot = s.pivotLevel ?? null;
  const rollPivot = s.rollingHigh20 ?? null;
  const pivot = clusterPivot != null && rollPivot != null
    ? Math.max(clusterPivot, rollPivot)
    : (clusterPivot ?? rollPivot);
  const usingCluster = clusterPivot != null && (rollPivot == null || clusterPivot >= rollPivot);
  const touches = usingCluster ? (s.pivotTouches ?? 0) : 0;
  const pivotQuality = usingCluster ? 0.8 + 0.2 * ramp(touches, 1, 3) : 0.8;
  const atr = s.atr14 ?? null;
  if (pivot != null && s.close != null && atr != null && atr > 0) {
    const atrsAbove = (s.close - pivot) / atr;
    c.trigger = ramp(atrsAbove, 0, 1) * 10 * pivotQuality;
  } else {
    const pf = s.pctFrom52wHigh;
    c.trigger = pf == null ? 0 : ramp(pf, -15, 0) * 10 * 0.8;
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
  // Delivery% is not ingested for any exchange we support, so the old 6-pt
  // `delivery` factor was always 0 and capped the gross score at 84. Those 6
  // points are redistributed into volume/OBV; the bucket still totals 20.
  const rv = s.relVolume ?? 0;
  c.volume = ramp(rv, 1, 3) * 14;
  const obv = s.obvSlope20 ?? null;
  c.obv = obv == null ? 0 : ramp(obv, 0, OBV_SLOPE_FULL) * 6;

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
  // Unknown context scores 0, never a consolation credit — otherwise the
  // context-free EOD pass hands every stock free points.
  const rs = ctx.relStrengthNifty;
  c.rel_strength = rs == null ? 0 : ramp(rs, -5, 15) * 5;
  // RS percentile vs universe (0..100). Full at 90+, none at ≤50.
  const rsP = s.rsPercentile;
  c.rs_percentile = rsP == null ? 0 : ramp(rsP, 50, 90) * 3;
  c.sector_strength = ctx.sectorStrength == null ? 0 : ctx.sectorStrength * 4;
  c.breadth = ctx.regime === "bullish" ? 3 : ctx.regime === "neutral" ? 1.5 : 0;

  // --- Forward-looking coil / setup bonuses ---
  // The old scorer only rewarded stocks that HAD already broken out. The
  // panel is a "futuristic breakout" read, so setup quality (squeeze,
  // volatility contraction, higher lows, drying volume, near-resistance
  // build-up, support-defence) now feeds this same score. These are
  // additive — if the setup isn't there, the component is 0.
  c.bb_squeeze = s.bbSqueeze ? 4 : 0;
  c.atr_contraction = s.atrContracting ? 3 : 0;
  c.higher_lows = s.higherLows ? 4 : 0;
  const dry = s.volDryUpRatio ?? null;
  c.vol_dryup = dry == null ? 0 : (1 - ramp(dry, 0.6, 1)) * 3;

  // Near-resistance build-up only counts BEFORE trigger fires (once price is
  // above the pivot, the trigger component already rewards it).
  const atrV = s.atr14 ?? null;
  const isTriggered = pivot != null && s.close != null && s.close > pivot;
  c.near_resistance = (s.nearResistance && !isTriggered) ? 3 : 0;

  // Support-defence bonus: within 0.5×ATR of a real support level (not the
  // range-low fallback) — a reversal-off-support setup for the next leg.
  const atSupport = atrV != null && atrV > 0 && s.support != null && !(s.supportFallback ?? false)
    ? Math.abs(s.close - s.support) / atrV <= 0.5
    : false;
  c.support_defended = atSupport ? 3 : 0;

  // Chart-pattern bonus — level-aware. Zero when no patterns are passed
  // (keeps legacy call sites identical).
  const patBonus = breakoutPatternBonus(patterns, s.nearResistance, atSupport, s.higherLows);
  c.pattern = patBonus.bonus;

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
  // Overheated momentum — RSI > 80 while trigger is fresh is a common
  // exhaustion tell (buyers already paid up).
  if (rsi != null && rsi > 80) {
    const p = ramp(rsi, 80, 95) * 4;
    if (p > 0) { penalties.overbought = p; penalty += p; }
  }
  // Bearish pattern at resistance / anywhere.
  if (patBonus.penalty > 0) { penalties.bearish_pattern = patBonus.penalty; penalty += patBonus.penalty; }

  const gross = Object.values(c).reduce((a, b) => a + b, 0);
  let total = gross - penalty;
  const regimeMult = ctx.regime === "bullish" ? 1.05 : ctx.regime === "bearish" ? 0.7 : 1;
  total *= regimeMult;
  const components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  for (const [k, v] of Object.entries(penalties)) components[`penalty_${k}`] = -Math.round(v * 10) / 10;
  components.regime_mult = Math.round(regimeMult * 100) / 100;
  if (patBonus.labels.length) components._pattern_labels = 0; // marker only; UI reads labels separately
  return { score: Math.round(clamp(total, 0, 100)), components };
}

export function preBreakoutScore(s: IndicatorSnapshot, ctx: MarketContext): ScoreResult {
  const c: Record<string, number> = {};

  // Bollinger squeeze (22)
  c.bb_squeeze = s.bbSqueeze ? 22 : 0;

  // ATR contraction (13)
  c.atr_contraction = s.atrContracting ? 13 : 0;

  // Higher lows (20)
  c.higher_lows = s.higherLows ? 20 : 0;

  // Within ATR-scaled band below resistance (20)
  c.near_resistance = s.nearResistance ? 20 : 0;

  // Quiet volume during the base (max 10), graded rather than a cliff edge:
  // ~0.75× the 20D average is ideal; heavy volume inside a base is churn, and
  // a total volume vacuum (<0.3×) means nobody is watching the name.
  const rv = s.relVolume;
  c.quiet_volume = rv == null ? 0 : clamp(10 * (1 - Math.abs(rv - 0.75) / 0.75), 0, 10);

  // Volume dry-up (max 5): 5D average volume shrinking versus the 20D average
  // is the classic pre-breakout supply exhaustion tell. 0.6× or less = full.
  const dry = s.volDryUpRatio ?? null;
  c.volume_dryup = dry == null ? 0 : (1 - ramp(dry, 0.6, 1)) * 5;

  // Trend filter: above 200 EMA adds conviction (10)
  c.above_ema200 = s.aboveEma200 ? 10 : 0;


  let total = Object.values(c).reduce((a, b) => a + b, 0);
  // Bearish regime dampens expectations
  if (ctx.regime === "bearish") total *= 0.7;

  const components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  return { score: Math.round(clamp(total, 0, 100)), components };
}

// ---- Threshold calibration -------------------------------------------------
// The 70/55/40 bands are fixed absolutes, so in a weak tape almost nothing
// qualifies and in a hot tape everything does. This reports where the day's
// universe actually sits, so the bands can be sanity-checked (and, later,
// adapted) against the live distribution instead of assumed.
export interface ScoreDistribution {
  n: number;
  p50: number | null;
  p70: number | null;
  p90: number | null;
  max: number | null;
  pct_at_or_above_strong: number;
  pct_at_or_above_moderate: number;
}
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}
export function scoreDistribution(scores: number[]): ScoreDistribution {
  const vals = scores.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = vals.length;
  const share = (t: number) => (n === 0 ? 0 : Math.round((vals.filter((v) => v >= t).length / n) * 1000) / 10);
  return {
    n,
    p50: percentile(vals, 50),
    p70: percentile(vals, 70),
    p90: percentile(vals, 90),
    max: n ? vals[n - 1] : null,
    pct_at_or_above_strong: share(SCORE_BAND_STRONG),
    pct_at_or_above_moderate: share(SCORE_BAND_MODERATE),
  };
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
// The v2 issues previously listed here (dead rs_percentile ternary, the
// always-zero `delivery` component, free points for unknown RS/sector
// context, the mis-documented quiet_volume band) have now been fixed in
// place above; v3 keeps its own, independently weighted factors.
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
// Single source of truth for "is this counter liquid enough to trust its
// volume?". Three-state on purpose: null means we simply do not know, which is
// neither a pass nor a hard fail — callers decide. The hard gate below treats
// unknown as a fail (we will not certify liquidity we cannot see); the v4
// volume bucket drops the factor instead of crediting it.
export function turnoverLiquid(avgTurnoverCr: number | null | undefined): boolean | null {
  if (avgTurnoverCr == null || !Number.isFinite(avgTurnoverCr)) return null;
  return avgTurnoverCr >= LIQUIDITY_MIN_TURNOVER_CR;
}

export function evaluateLiquidity(input: LiquidityInput): LiquidityGate {
  const reasons: string[] = [];
  if (input.close == null || input.close < LIQUIDITY_MIN_PRICE) reasons.push(`price below ₹${LIQUIDITY_MIN_PRICE}`);
  if (input.marketCapCr == null || input.marketCapCr < LIQUIDITY_MIN_MARKET_CAP_CR) reasons.push(`market cap below ₹${LIQUIDITY_MIN_MARKET_CAP_CR}Cr`);
  if (turnoverLiquid(input.avgTurnoverCr) !== true) {
    reasons.push(input.avgTurnoverCr == null
      ? "avg turnover unknown"
      : `avg turnover below ₹${LIQUIDITY_MIN_TURNOVER_CR}Cr/day`);
  }
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
  // Nullable: "unknown" must stay distinguishable from "not rising" (the v4
  // MACD factor abstains on null instead of docking the stock 40%).
  macdHistRising: boolean | null;
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
  c.obv = s.obvSlope20 == null ? 0 : ramp(s.obvSlope20, 0, OBV_SLOPE_FULL) * 5;
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

// ============================================================================
// Breakout tracking — multi-day forward follow-through. Additive; nothing
// here touches the frozen v2/v3 scorers above. Consumed by
// market-pipeline-aggregates' episode pass and the Breakout UI. Thresholds
// are the single source of truth for both.
// ============================================================================

// Min breakout_score for a stock to enter the tracker.
export const BREAKOUT_QUALIFY_SCORE = 70;
// Return % vs entry that promotes an open episode to "extended".
export const EXTEND_PCT = 8;
// Drawdown % below entry that fails an episode.
export const FAIL_PCT = 6;
// Consecutive sub-threshold sessions before an open episode is "cooled".
export const COOL_DAYS = 3;
// Sessions after which an open episode auto-closes (tracking horizon).
export const MAX_TRACK_DAYS = 15;
// Recent-score history cap kept per episode.
export const SCORE_TREND_CAP = 15;

export type BreakoutStatus = "active" | "extended" | "cooled" | "failed" | "closed";

export interface BreakoutEpisodeState {
  entryClose: number;
  currentClose: number;
  peakClose: number;
  daysTracked: number;
  belowThresholdDays: number;
  scoreTrend: number[]; // recent breakout scores, oldest→newest
  lastScore: number;
}

// 0-100 quality grade of an in-flight breakout episode. Rewards follow-through
// (return above entry, still near its peak, stable/rising score) and punishes
// fade (deep pullback from peak, decaying score, prolonged cooling). Used for
// the tracker's "Health" column and to rank open episodes.
export function breakoutFollowThroughScore(ep: BreakoutEpisodeState): ScoreResult {
  const c: Record<string, number> = {};
  const entry = ep.entryClose;
  const retPct = entry > 0 ? ((ep.currentClose - entry) / entry) * 100 : 0;
  const peakRetPct = entry > 0 ? ((ep.peakClose - entry) / entry) * 100 : 0;

  // --- Return since entry (35) --- rewards follow-through; below entry → 0.
  c.return = ramp(retPct, 0, EXTEND_PCT) * 35;

  // --- Hold near peak (25) --- fraction of peak gain retained. A pick that
  // ran +10% then gave it all back scores near 0 here even if still >entry.
  const hold = peakRetPct > 0 ? clamp(retPct / peakRetPct, 0, 1) : (retPct >= 0 ? 1 : 0);
  c.hold_peak = hold * 25;

  // --- Score stability / trend (25) --- current level + slope over the window.
  c.score_level = ramp(ep.lastScore, 50, 85) * 15;
  const t = ep.scoreTrend;
  const slope = t.length >= 2 ? t[t.length - 1] - t[0] : 0;
  c.score_slope = ramp(slope, -10, 10) * 10;

  // --- Maturity (15) --- a young episode still proving itself keeps partial
  // credit; prolonged cooling bleeds it out.
  c.freshness = (1 - ramp(ep.daysTracked, 1, MAX_TRACK_DAYS)) * 8;
  c.not_cooling = (1 - ramp(ep.belowThresholdDays, 0, COOL_DAYS)) * 7;

  // --- Penalty: drawdown below entry ---
  let penalty = 0;
  const penalties: Record<string, number> = {};
  if (retPct < 0) {
    const p = ramp(-retPct, 0, FAIL_PCT) * 25;
    penalties.drawdown = p; penalty += p;
  }

  const gross = Object.values(c).reduce((a, b) => a + b, 0);
  const total = gross - penalty;
  const components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  for (const [k, v] of Object.entries(penalties)) components[`penalty_${k}`] = -Math.round(v * 10) / 10;
  return { score: Math.round(clamp(total, 0, 100)), components };
}

export interface EpisodeTickInput {
  status: BreakoutStatus;
  entryClose: number;
  close: number;
  score: number;
  daysTracked: number;        // BEFORE this tick
  belowThresholdDays: number; // BEFORE this tick
}
export interface EpisodeTickResult {
  status: BreakoutStatus;
  belowThresholdDays: number;
  returnPct: number;
}

// Pure lifecycle transition for one open episode given today's close + score.
// Kept here (not inline in the edge fn) so it's unit-tested and the UI can
// preview the same rules. Priority: terminal stays terminal → hard fail →
// age-out → extended → cooled → recover → hold.
export function nextEpisodeStatus(inp: EpisodeTickInput): EpisodeTickResult {
  const { entryClose, close, score } = inp;
  const returnPct = entryClose > 0 ? ((close - entryClose) / entryClose) * 100 : 0;
  const belowThresholdDays = score < BREAKOUT_QUALIFY_SCORE ? inp.belowThresholdDays + 1 : 0;
  const daysTracked = inp.daysTracked + 1;

  if (inp.status === "failed" || inp.status === "closed") {
    return { status: inp.status, belowThresholdDays, returnPct };
  }
  if (returnPct <= -FAIL_PCT) {
    return { status: "failed", belowThresholdDays, returnPct };
  }
  if (daysTracked >= MAX_TRACK_DAYS) {
    return { status: "closed", belowThresholdDays, returnPct };
  }
  if (returnPct >= EXTEND_PCT && score >= BREAKOUT_QUALIFY_SCORE - 10) {
    return { status: "extended", belowThresholdDays, returnPct };
  }
  if (belowThresholdDays >= COOL_DAYS) {
    return { status: "cooled", belowThresholdDays, returnPct };
  }
  if (inp.status === "cooled" && score >= BREAKOUT_QUALIFY_SCORE) {
    return { status: "active", belowThresholdDays, returnPct };
  }
  // De-escalate: an "extended" episode that gives back most of the extension
  // is not extended any more. Without this, the label was one-way — a name
  // that ran +9% and then round-tripped to +1% stayed badged as extended
  // until it either failed outright or aged out.
  if (inp.status === "extended" && returnPct < EXTEND_PCT * 0.5) {
    return { status: "active", belowThresholdDays, returnPct };
  }
  return { status: inp.status === "extended" ? "extended" : "active", belowThresholdDays, returnPct };
}

// ============================================================================
// Score display / decision bands — single source of truth. Alerts, the AI
// recommendation prompt and the UI badge all import these instead of
// hardcoding their own copies.
// ============================================================================
export const SCORE_BAND_STRONG = BREAKOUT_QUALIFY_SCORE; // 70+  strong / buy
export const SCORE_BAND_MODERATE = 55;                   // 55-69 moderate / hold
export const SCORE_BAND_WEAK = 40;                       // 40-54 weak / wait

// ============================================================================
// v4 — the single, coverage-aware Breakout Intelligence score.
//
// Eight buckets, weights summing to 100. The defining property: a bucket with
// NO data for a symbol is *renormalised away* (its weight is redistributed
// across the buckets that do have data) instead of silently scoring 0. v2
// scored missing context as 0, which depressed the entire universe (observed
// live: mean 26, max 67, nothing ever reaching the 70 band) and made it
// impossible to tell "bad setup" from "no data".
//
// Additive: breakoutScore / preBreakoutScore / swingScore / intradayScore
// above are untouched, so AutoTrade, alerts and the AI prompt keep working
// while consumers migrate onto v4.
// ============================================================================

export const V4_WEIGHTS = {
  volume: 16,
  indicators: 16,
  setups: 13,
  levels: 22,
  strength: 13,
  patterns: 11,
  sentiment: 9,
} as const;
export type V4Bucket = keyof typeof V4_WEIGHTS;

// Fundamentals are NOT a bucket. Good books can never manufacture a breakout
// score on their own, and 8 additive points let them do exactly that. They
// apply as a multiplier on the technical score instead: at worst a 10% haircut
// for a leveraged, shrinking business, at best a 5% nudge for a clean one.
export const V4_FUNDAMENTAL_MULT_MIN = 0.90;
export const V4_FUNDAMENTAL_MULT_MAX = 1.05;

// Below this many sessions the chart simply cannot be read — no 52w range, no
// 200 EMA, no base. Returning a low number there is indistinguishable from
// "bad setup", so the scorer returns null with a reason instead.
export const V4_MIN_BARS = 120;

// A bucket needs at least this share of its own sub-factors (by sub-weight)
// present before it counts as covered at all.
export const BUCKET_MIN_COVERAGE = 0.35;
// Below this share of TOTAL weight covered, the chart is unreadable and we
// refuse to emit a number — a 20 that means "no data" is worse than no score.
const MIN_TOTAL_COVERAGE = 0.45;

export interface V4Fundamentals {
  revenueGrowthYoy: number | null;
  profitGrowthYoy: number | null;
  roe: number | null;
  debtToEquity: number | null;
  promoterHolding: number | null;
  peTtm: number | null;
}
export interface V4Sentiment {
  // 'buy' | 'accumulate' | 'hold' | 'reduce' | 'sell' (free text tolerated)
  aiVerdict: string | null;
  aiConfidence: number | null;   // 0..1 (0..100 also accepted)
  newsSentiment: number | null;  // −1..1, window average
  newsCount: number;
  // Sessions until the next results date / ex-date; null when none known.
  eventInDays: number | null;
}
export interface V4Input {
  s: IndicatorSnapshot;
  ctx: MarketContext;
  patterns?: BreakoutPatterns;
  // Same detector run on weekly candles. When a daily structure is confirmed
  // by the weekly chart the pattern bucket gets a multi-timeframe kicker;
  // when the weekly is topping, the bearish penalty is amplified.
  patternsWeekly?: BreakoutPatterns | null;
  weekly?: WeeklySnapshot | null;
  adv?: AdvancedSignals;
  fundamentals?: V4Fundamentals | null;
  sentiment?: V4Sentiment | null;
  liquidity?: LiquidityGate;
  // Sessions since the 20/50 EMA crossed up (null = unknown, not "no cross").
  emaCross2050FreshDays?: number | null;
  emaCross50200FreshDays?: number | null;
  // Average daily turnover in ₹ Cr — makes the volume bucket price-aware.
  avgTurnoverCr?: number | null;
  // 0..100 percentile of this symbol's rel-volume / ATR% WITHIN its market-cap
  // tier. Small caps structurally run hotter on both, so raw thresholds put
  // micro-caps permanently at the top of the list. Supplied by the aggregates
  // pass; when absent the scorer falls back to absolute thresholds.
  tierRelVolumePct?: number | null;
  tierAtrPct?: number | null;
  // Sessions of history behind the snapshot; overrides s.barsAvailable.
  barsAvailable?: number | null;
}

export interface V4Result {
  // null when the inputs are too sparse to say anything honest.
  score: number | null;
  rawBeforePenalty: number | null;
  unavailableReason: string | null;
  // Points actually contributed by each bucket, after renormalisation.
  buckets: Record<string, number>;
  // 0..1 share of each bucket's sub-factors that had data.
  coverage: Record<string, number>;
  components: Record<string, number>;
  penalties: Record<string, number>;
  // 0.90–1.05 fundamentals multiplier actually applied (1 when unknown).
  fundamentalMultiplier: number;
  liquidityOk: boolean;
  liquidityReasons: string[];
}

// One sub-factor: a 0..1 value, or null when the input is missing.
type Factor = [name: string, weight: number, value: number | null];

// Collapse sub-factors into a 0..1 bucket value plus its coverage share,
// renormalising within the bucket over the factors that do have data.
function rollup(factors: Factor[]): { value: number | null; coverage: number; detail: Record<string, number> } {
  let wSum = 0, wHave = 0, acc = 0;
  const detail: Record<string, number> = {};
  for (const [name, w, v] of factors) {
    wSum += w;
    if (v == null) continue;
    wHave += w;
    const cv = clamp(v, 0, 1);
    acc += cv * w;
    detail[name] = Math.round(cv * 1000) / 1000;
  }
  if (wSum <= 0 || wHave <= 0) return { value: null, coverage: 0, detail };
  const coverage = wHave / wSum;
  if (coverage < BUCKET_MIN_COVERAGE) return { value: null, coverage, detail };
  return { value: acc / wHave, coverage, detail };
}

const freshCross = (d: number | null | undefined): number | null =>
  d == null ? null : (d < 0 ? 0 : 1 - ramp(d, 0, 25));

export function breakoutScoreV4(input: V4Input): V4Result {
  const { s, ctx, patterns, weekly, adv } = input;
  const f = input.fundamentals ?? null;
  const sent = input.sentiment ?? null;
  const liquidity = input.liquidity ?? { ok: true, reasons: [] };

  const atr = s.atr14 != null && s.atr14 > 0 ? s.atr14 : null;
  const close = s.close ?? null;

  // ---- 0. Readability gate ------------------------------------------------
  // Refuse to score a chart that isn't there. "20 because the setup is bad"
  // and "20 because we have 40 bars" must never look the same.
  //
  // An UNKNOWN bar count is also a refusal. The old guard was
  // `bars != null && bars < V4_MIN_BARS`, so a snapshot that never populated
  // barsAvailable skipped the gate entirely and a 30-bar chart scored as if
  // fully readable — the exact failure the gate exists to prevent.
  const bars = input.barsAvailable ?? s.barsAvailable ?? null;
  if (bars == null || bars < V4_MIN_BARS) {
    return {
      score: null, rawBeforePenalty: null,
      unavailableReason: bars == null
        ? "history length unknown — cannot confirm the chart is readable"
        : `only ${bars} sessions of history — needs ${V4_MIN_BARS} to read the chart`,
      buckets: {}, coverage: {}, components: {}, penalties: {},
      fundamentalMultiplier: 1,
      liquidityOk: liquidity.ok, liquidityReasons: liquidity.reasons,
    };
  }

  // ---- 1. Volume & participation -----------------------------------------
  // Rel volume is measured against the 30D MEDIAN when available — the mean is
  // dragged up by one climactic day, which then hides the next real expansion.
  // It is also turnover-gated: 3× volume on a ₹5 lakh/day counter is noise, not
  // participation, so below the turnover floor the factor is dropped entirely
  // (null → renormalised away) rather than rewarded at half credit.
  const relMean30 = s.volAvg30 != null && s.volAvg30 > 0 && s.volume != null
    ? s.volume / s.volAvg30
    : (s.relVolume ?? null);
  const rel30 = s.relVolumeMedian30 ?? relMean30;
  // Three-state, shared with evaluateLiquidity: true = liquid, false = known
  // thin, null = unknown. Previously this read `== null || >= floor`, i.e.
  // unknown turnover was assumed liquid here while the liquidity gate treated
  // the very same null as an outright fail — one field, two opposite biases.
  const turnoverOk = turnoverLiquid(input.avgTurnoverCr);
  // Prefer the size-tier percentile when the caller computed one: a 2.5× day on
  // a large cap is a far rarer event than on a micro cap.
  // Known-illiquid is a real 0, not missing data: nulling it renormalised the
  // 45% weight onto OBV / dry-up / delivery, so a thin counter had its volume
  // bucket carried by the three soft factors instead of being marked down.
  // Unknown turnover, by contrast, drops the factor (null) rather than crediting it.
  const relVolFactor = turnoverOk === false ? 0
    : turnoverOk == null ? null
    : input.tierRelVolumePct != null ? ramp(input.tierRelVolumePct, 50, 95)
    : rel30 == null ? null : ramp(rel30, 1, 3);

  // Dry-up belongs to the BASE window: measured through today the breakout bar
  // inflates the 5D average and kills the factor exactly when the setup is best
  // (and made rel-volume and dry-up mutually exclusive, capping the bucket).
  const dryUp = s.volDryUpRatioBase ?? s.volDryUpRatio ?? null;
  const volume = rollup([
    ["rel_volume_30d", 0.45, relVolFactor],
    ["obv_slope", 0.20, s.obvSlope20 == null ? null : ramp(s.obvSlope20, 0, V4_OBV_SLOPE_FULL)],
    ["vol_dryup", 0.15, dryUp == null ? null : 1 - ramp(dryUp, 0.6, 1)],
    ["delivery_pct", 0.20, ctx.deliveryPct == null ? null : ramp(ctx.deliveryPct, 30, 65)],
  ]);

  // ---- 2. Indicators ------------------------------------------------------
  const rsi = s.rsi14;
  const rsiVal = rsi == null ? null
    // Floor softened to 40: a base breakout often prints RSI in the low 50s,
    // and the old hard 0 at 45 zeroed a quarter of the bucket for those.
    : rsi <= 40 ? 0
    : rsi < 60 ? (rsi - 40) / 20
    : rsi <= 75 ? 1
    : rsi < 85 ? (85 - rsi) / 10
    : 0;
  // A null histogram read means "can't tell", so MACD is scored on the
  // line/signal cross alone and rescaled — never docked 0.4 for a data gap.
  const macdVal = s.macd == null || s.macdSignal == null
    ? null
    : s.macdHistRising == null
      ? (s.macd > s.macdSignal ? 1 : 0)
      : (s.macd > s.macdSignal ? 0.6 : 0) + (s.macdHistRising ? 0.4 : 0);
  // ATR% sanity: too quiet can't travel, too wild can't be held. 2–6% ideal.
  const atrPct = s.atrPct;
  // The tier percentile is only meaningful when this symbol actually has a
  // volatility read; without that guard the factor reported data it never had
  // and inflated bucket coverage.
  const atrVal = atrPct == null ? null
    : input.tierAtrPct != null
    // Tier-relative: mid-range volatility for the size tier is what travels;
    // both extremes of the tier are penalised.
    ? 1 - Math.abs(input.tierAtrPct - 55) / 55
    : atrPct < 2 ? ramp(atrPct, 0.5, 2)
    : atrPct <= 6 ? 1
    : 1 - ramp(atrPct, 6, 14);
  const indicators = rollup([
    ["rsi", 0.25, rsiVal],
    ["macd", 0.20, macdVal],
    ["adx", 0.20, s.adx14 == null ? null : ramp(s.adx14, 15, 30)],
    ["atr_pct", 0.10, atrVal],
    // Capped at %B = 1: past the upper band this is overextension, which the
    // overextension penalty already charges for — don't pay for it here too.
    ["percent_b", 0.10, adv?.percentB == null ? null : ramp(Math.min(adv.percentB, 1), 0.5, 1)],
    ["mfi", 0.10, adv?.mfi14 == null ? null : ramp(adv.mfi14, 50, 80)],
    ["supertrend", 0.05, adv?.supertrendDir == null ? null : (adv.supertrendDir === 1 ? 1 : 0)],
  ]);

  // ---- 3. Setups / EMA structure -----------------------------------------
  // Cross ages come from the snapshot when the caller didn't pass them
  // explicitly — for a long time NOTHING passed them, so both cross factors
  // were permanently null and the 25% of this bucket they own never existed.
  const cross2050 = input.emaCross2050FreshDays ?? s.emaCross2050FreshDays ?? null;
  const cross50200 = input.emaCross50200FreshDays ?? s.emaCross50200FreshDays ?? null;
  // Weekly trend through rollup, so one missing weekly sub-signal renormalises
  // within the factor instead of scoring a silent zero.
  // computeWeeklySnapshot returns null below 25 weekly bars, so any snapshot
  // that exists here already has enough history — the old `barsW <= 0` /
  // `barsW < 3` guards were unreachable and implied edge-case handling that
  // does not live here. Missing history means `weekly == null`, full stop.
  const weeklyVal = weekly == null ? null : rollup([
    ["above_ema20w", 0.50, weekly.ema20W == null ? null : (weekly.aboveEma20W ? 1 : 0)],
    ["trend_up_w", 0.30, weekly.rsi14W == null ? null : (weekly.trendUpW ? 1 : 0)],
    ["higher_lows_w", 0.20, weekly.higherLowsW ? 1 : 0],
  ]).value;

  const setups = rollup([
    ["ema_alignment", 0.30, s.ema20 == null || s.ema50 == null || s.ema200 == null
      ? null : (s.emaAligned ? 1 : (s.ema20 > s.ema50 ? 0.5 : 0))],
    ["above_ema200", 0.25, s.ema200 == null ? null : (s.aboveEma200 ? 1 : 0)],
    ["cross_20_50", 0.15, freshCross(cross2050)],
    ["cross_50_200", 0.10, freshCross(cross50200)],
    ["weekly_trend", 0.20, weeklyVal],
  ]);

  // ---- 4. Support / resistance & trigger ---------------------------------
  const clusterPivot = s.pivotLevel ?? null;
  const rollPivot = s.rollingHigh20 ?? null;
  const pivot = clusterPivot != null && rollPivot != null
    ? Math.max(clusterPivot, rollPivot)
    : (clusterPivot ?? rollPivot);
  const usingCluster = clusterPivot != null && (rollPivot == null || clusterPivot >= rollPivot);
  // Volume-weighted touch quality of the level that actually WON. Grading only
  // the cluster path structurally capped every new-high breakout at 0.75 even
  // when the rolling high was itself a heavily defended ceiling — so the
  // rolling-high path now gets its own touch read, and an unknown read falls
  // back to the neutral 0.85 rather than the floor.
  const touchStrength = usingCluster
    ? (s.pivotTouchQuality ?? s.pivotTouches ?? null)
    : (s.rollingHigh20TouchQuality ?? s.rollingHigh20Touches ?? null);
  const pivotQuality = touchStrength == null
    ? 0.85
    : 0.75 + 0.25 * ramp(touchStrength, 1, 3.5);
  const cir = s.closeInRangePct;
  // Gap-and-fade guard: a pivot cleared by the opening print and then given
  // back into the close is not a breakout. Below a hard floor of 35% close-in-
  // range the trigger earns almost nothing no matter how far above the pivot
  // the print went; full credit needs a close in the top third of the bar.
  const closeQuality = cir == null ? 0.85
    : cir < 35 ? 0.2 + 0.3 * ramp(cir, 0, 35)
    : 0.5 + 0.5 * ramp(cir, 35, 70);
  let triggerVal: number | null = null;
  if (pivot != null && close != null && atr != null) {
    const atrsAbove = (close - pivot) / atr;
    // Extension taper: full credit used to run unbounded, so a name already 6
    // ATR past its pivot scored exactly like a clean day-one clearance and only
    // the separate overextension penalty pushed back. Credit fades from 2.5 ATR
    // above the pivot — the move is real, but it is no longer an entry.
    const extTaper = 1 - 0.45 * ramp(atrsAbove, 2.5, 6);
    triggerVal = ramp(atrsAbove, 0, 1) * pivotQuality * closeQuality * extTaper;
    // Pre-trigger coil right under a real ceiling still earns partial credit.
    if (close <= pivot) {
      const atrsBelow = (pivot - close) / atr;
      triggerVal = Math.max(triggerVal, (1 - ramp(atrsBelow, 0, 1.5)) * 0.45 * pivotQuality);
    }
  } else if (s.pctFrom52wHigh != null) {
    triggerVal = ramp(s.pctFrom52wHigh, -15, 0) * 0.8;
  }
  const supportReal = s.support != null && !(s.supportFallback ?? false);
  const supportAtrs = supportReal && atr != null && close != null
    ? Math.abs(close - s.support!) / atr
    : null;
  const atSupport = supportAtrs != null && supportAtrs <= 0.5;
  // Distance-graded, and null (renormalised away) when the "support" is only the
  // lookback low. The old flat 0.3 handed every symbol with any support value a
  // third of the factor for nothing.
  const supportDefence = supportAtrs == null ? null : 1 - ramp(supportAtrs, 0.5, 3);
  // Freshness is a real 0 when there is no live breakout or the last one failed
  // — only genuinely unknown state may be renormalised away, otherwise the 10%
  // weight silently migrated to the trigger and rewarded non-breakouts.
  const freshKind = s.breakoutStateKind ?? null;
  const freshVal = s.breakoutFreshnessDays != null
    ? Math.max(0, 1 - s.breakoutFreshnessDays / 5)
    : freshKind === "none" || freshKind === "failed" ? 0
    : null;
  const levels = rollup([
    // close-in-range is folded into the trigger above rather than scored
    // independently — paying for it twice let a gap-up fade rank well.
    ["trigger", 0.45, triggerVal],
    ["freshness", 0.10, freshVal],
    ["base_tightness", 0.15, s.baseTightness == null ? null : 1 - ramp(s.baseTightness, 0.02, 0.08)],
    ["base_depth", 0.10, s.baseDepthPct == null ? null : 1 - ramp(s.baseDepthPct, 8, 30)],
    ["base_duration", 0.10, s.baseDurationDays == null ? null : ramp(s.baseDurationDays, 10, 30)],
    ["support_defence", 0.10, supportDefence],
  ]);

  // ---- 5. Range & strength -----------------------------------------------
  const strength = rollup([
    // The old ramp saturated at -1%, so a retest and a fresh all-time high were
    // indistinguishable. Reserve the top tenth of the factor for actually
    // taking out the high.
    ["pos_52w", 0.25, s.pctFrom52wHigh == null ? null
      : 0.9 * ramp(s.pctFrom52wHigh, -35, -3) + 0.1 * ramp(s.pctFrom52wHigh, -3, 0)],
    ["rel_strength", 0.25, ctx.relStrengthNifty == null ? null : ramp(ctx.relStrengthNifty, -5, 15)],
    ["rs_percentile", 0.20, s.rsPercentile == null ? null : ramp(s.rsPercentile, 50, 90)],
    ["sector_strength", 0.20, ctx.sectorStrength],
    ["breadth", 0.10, ctx.regime == null ? null : (ctx.regime === "bullish" ? 1 : ctx.regime === "neutral" ? 0.5 : 0)],
  ]);

  // ---- 6. Chart patterns --------------------------------------------------
  const patRaw = breakoutPatternBonus(patterns ?? undefined, s.nearResistance, atSupport, s.higherLows);
  // ---- Multi-timeframe agreement -----------------------------------------
  // A daily structure that the weekly chart also shows is a materially better
  // setup than a daily-only read; a bullish daily under a weekly top is worse.
  const wk = input.patternsWeekly ?? null;
  const wkBull = hasBullStructure(wk);
  const wkBear = !!(wk && (wk.headShoulders || wk.doubleTop || wk.risingWedge || wk.descendingTriangle ||
    wk.tripleTop || wk.roundedTop || wk.inverseCupAndHandle || wk.bearFlag || wk.bearPennant ||
    wk.descendingChannel || wk.distribution));
  const dailyBull = hasBullStructure(patterns);
  const mtfBonus = dailyBull && wkBull ? 2 : 0;
  const mtfPenalty = dailyBull && wkBear ? 1.5 : (wkBear ? 1 : 0);
  const pat = {
    bonus: clamp(patRaw.bonus + mtfBonus, 0, 10),
    penalty: clamp(patRaw.penalty + mtfPenalty, 0, 6),
    labels: mtfBonus > 0 ? [...patRaw.labels, "weekly agreement"] : patRaw.labels,
  };
  // Coverage tracks whether the detector had enough history to have an opinion.
  // Claiming full coverage for an all-false flag set scored "we looked, nothing
  // there" identically to "we never looked" — and an UNKNOWN bar count used to
  // count as "enough history", which is the same mistake inverted.
  const patternBars = input.barsAvailable ?? s.barsAvailable ?? null;
  const patternsScored = patterns != null && patternBars != null && patternBars >= 60;

  const patterns6 = patternsScored
    ? {
        // Normalised against the reachable bonus, not the theoretical cap.
        value: clamp(pat.bonus / V4_PATTERN_BONUS_FULL, 0, 1),
        coverage: 1,
        detail: {
          pattern_bonus: Math.round(clamp(pat.bonus / V4_PATTERN_BONUS_FULL, 0, 1) * 1000) / 1000,
          pattern_count: pat.labels.length,
        },
      }
    : { value: null, coverage: 0, detail: {} as Record<string, number> };

  // ---- 7. Fundamentals — a MULTIPLIER, not points -------------------------
  // Applied to the technical total below (0.90–1.05). "Good chart, bad books"
  // gets marked down; clean books can nudge, never carry.
  const fundRoll = rollup([
    ["revenue_growth", 0.20, f?.revenueGrowthYoy == null ? null : ramp(f.revenueGrowthYoy, 0, 25)],
    ["profit_growth", 0.20, f?.profitGrowthYoy == null ? null : ramp(f.profitGrowthYoy, 0, 30)],
    ["roe", 0.25, f?.roe == null ? null : ramp(f.roe, 8, 25)],
    ["debt_equity", 0.20, f?.debtToEquity == null ? null : 1 - ramp(f.debtToEquity, 0.5, 2)],
    ["promoter_holding", 0.10, f?.promoterHolding == null ? null : ramp(f.promoterHolding, 25, 55)],
    ["valuation", 0.05, f?.peTtm == null ? null : (f.peTtm <= 0 ? 0 : 1 - ramp(f.peTtm, 40, 90))],
  ]);
  const fundMult = fundRoll.value == null
    ? 1
    : V4_FUNDAMENTAL_MULT_MIN + (V4_FUNDAMENTAL_MULT_MAX - V4_FUNDAMENTAL_MULT_MIN) * fundRoll.value;

  // ---- 8. AI verdict + news / corporate actions ---------------------------
  const verdict = (sent?.aiVerdict ?? "").toLowerCase();
  const verdictBase = verdict.includes("strong buy") ? 1
    : verdict.includes("buy") || verdict.includes("accumulate") ? 0.85
    : verdict.includes("hold") || verdict.includes("neutral") ? 0.5
    : verdict.includes("reduce") ? 0.25
    : verdict.includes("sell") || verdict.includes("avoid") ? 0
    : null;
  const conf = sent?.aiConfidence == null ? null : (sent.aiConfidence > 1 ? sent.aiConfidence / 100 : sent.aiConfidence);
  const sentiment = rollup([
    ["ai_verdict", 0.50, verdictBase == null ? null : 0.5 + (verdictBase - 0.5) * clamp(conf ?? 0.6, 0, 1)],
    ["news_sentiment", 0.30, sent == null || sent.newsCount === 0 || sent.newsSentiment == null
      // Shrink toward neutral by article count: one stale headline must not
      // carry the same weight as broad, consistent coverage.
      ? null
      : clamp(0.5 + (clamp((sent.newsSentiment + 1) / 2, 0, 1) - 0.5) * ramp(sent.newsCount, 1, 5), 0, 1)],
    // Ramps over 3→10 sessions only. Inside 2 sessions the hard event-blackout
    // cap below takes over, and the old 0→5 ramp charged for the same fact twice.
    ["event_clear", 0.20, sent?.eventInDays == null ? null : ramp(sent.eventInDays, 3, 10)],
  ]);

  // ---- Weight renormalisation --------------------------------------------
  const parts: Array<[V4Bucket, { value: number | null; coverage: number; detail: Record<string, number> }]> = [
    ["volume", volume], ["indicators", indicators], ["setups", setups], ["levels", levels],
    ["strength", strength], ["patterns", patterns6], ["sentiment", sentiment],
  ];
  let weightHave = 0, weighted = 0;
  const coverage: Record<string, number> = {};
  const components: Record<string, number> = {};
  for (const [name, part] of parts) {
    coverage[name] = Math.round(part.coverage * 100) / 100;
    for (const [k, v] of Object.entries(part.detail)) components[`${name}.${k}`] = v;
    if (part.value == null) continue;
    weightHave += V4_WEIGHTS[name];
    weighted += part.value * V4_WEIGHTS[name];
  }
  const totalWeight = Object.values(V4_WEIGHTS).reduce((a, b) => a + b, 0);
  const coverShare = weightHave / totalWeight;

  const buckets: Record<string, number> = {};
  coverage.fundamentals = Math.round(fundRoll.coverage * 100) / 100;
  for (const [k, v] of Object.entries(fundRoll.detail)) components[`fundamentals.${k}`] = v;
  if (weightHave <= 0 || coverShare < MIN_TOTAL_COVERAGE) {
    return {
      score: null,
      rawBeforePenalty: null,
      unavailableReason: weightHave <= 0
        ? "no scoreable inputs for this symbol"
        : `insufficient data — only ${Math.round(coverShare * 100)}% of the model has inputs`,
      buckets, coverage, components, penalties: {},
      fundamentalMultiplier: 1,
      liquidityOk: liquidity.ok, liquidityReasons: liquidity.reasons,
    };
  }
  // Renormalise: each present bucket's weight is scaled up so the present
  // weights sum to 100 again.
  const scale = totalWeight / weightHave;
  for (const [name, part] of parts) {
    if (part.value == null) { buckets[name] = 0; continue; }
    buckets[name] = Math.round(part.value * V4_WEIGHTS[name] * scale * 10) / 10;
  }
  const raw = (weighted / weightHave) * 100;

  // ---- Penalties ----------------------------------------------------------
  // Point penalties are deducted AFTER the multipliers, not before. Deducting
  // first let the regime / fundamentals / coverage multipliers dilute them: a
  // 25-point illiquidity penalty cost only ~21 points in a bearish regime, and
  // the event blackout (applied post-multiplier) never diluted at all — two
  // penalty families in the same map with incompatible units. Now a stated
  // penalty costs exactly what it says.
  const penalties: Record<string, number> = {};
  let penalty = 0;
  if (atr != null && s.ema20 != null && close != null) {
    const p = ramp((close - s.ema20) / atr, 3, 6) * 15;
    if (p > 0) { penalties.overextension = Math.round(p * 10) / 10; penalty += p; }
  }
  if (rel30 != null && rel30 > 0 && rel30 < 0.8) {
    const p = (0.8 - rel30) * 10;
    penalties.thin_volume = Math.round(p * 10) / 10; penalty += p;
  }
  if (rsi != null && rsi > 80) {
    const p = ramp(rsi, 80, 95) * 6;
    if (p > 0) { penalties.overbought = Math.round(p * 10) / 10; penalty += p; }
  }
  if (pat.penalty > 0) { penalties.bearish_pattern = Math.round(pat.penalty * 10) / 10; penalty += pat.penalty; }
  // Failed breakout: price triggered recently and has since fallen back INTO
  // the base. Freshness decay alone only stops paying points; a failure is
  // strictly worse than never having triggered, and the deeper the re-entry
  // the worse it is (up to 1 ATR back inside = full penalty).
  //
  // The recency window reads breakoutStateDays, which is kept for the failed
  // state too. breakoutFreshnessDays is fresh-only by construction, so the old
  // `(s.breakoutFreshnessDays ?? 1) <= 10` was always true — a breakout that
  // failed months ago was charged as if it had failed yesterday.
  const failedLevel = s.breakoutLevelCleared ?? pivot;
  const failedDays = s.breakoutStateDays ?? null;
  if (freshKind === "failed" && failedLevel != null && close != null && close < failedLevel &&
      failedDays != null && failedDays <= 10) {
    const depth = atr != null ? ramp((failedLevel - close) / atr, 0.1, 1) : 0.5;
    const p = 5 + 9 * depth;
    penalties.failed_breakout = Math.round(p * 10) / 10; penalty += p;
  }
  if (!liquidity.ok) { penalties.illiquid = 25; penalty += 25; }

  const regimeMult = ctx.regime === "bullish" ? 1.05 : ctx.regime === "bearish" ? 0.85 : 1;
  // Missing coverage is charged exactly once. It used to be charged twice: the
  // missing weight was first redistributed over the present buckets (so a thin
  // name had to earn the same 100 points from fewer factors) and THEN the score
  // was multiplied by a 0.9-1.0 coverage haircut for the same gap. Coverage is
  // now metadata only (`components.coverage_share`, surfaced in the explain
  // page) so a thin score reads as thin instead of being silently discounted.
  const adjusted = clamp(raw * regimeMult * fundMult, 0, 100);
  let total = clamp(adjusted - penalty, 0, 100);

  // Event blackout: results / ex-date inside two sessions makes the setup
  // un-tradable, not merely weaker — a binary event decides the next print, not
  // the base. Hard-cap into the WATCH band instead of shaving a few points.
  if (sent?.eventInDays != null && sent.eventInDays <= 2) {
    const capped = Math.min(total, SCORE_BAND_WEAK + 9); // top of WATCH, below MODERATE
    if (capped < total) penalties.event_blackout = Math.round((total - capped) * 10) / 10;
    total = capped;
  }

  components.regime_mult = Math.round(regimeMult * 100) / 100;
  components.fundamental_mult = Math.round(fundMult * 1000) / 1000;
  components.coverage_share = Math.round(coverShare * 100) / 100;
  components.coverage_mult = 1; // retired — kept at 1 so stored rows stay comparable
  components.score_before_penalty = Math.round(adjusted * 10) / 10;


  return {
    score: Math.round(total),
    rawBeforePenalty: Math.round(raw * 10) / 10,
    unavailableReason: null,
    buckets, coverage, components, penalties,
    fundamentalMultiplier: Math.round(fundMult * 1000) / 1000,
    liquidityOk: liquidity.ok, liquidityReasons: liquidity.reasons,
  };
}

// Percentile-anchored bands, so "STRONG" means the same thing in a weak tape
// and a hot one. Cut-offs are derived from the day's own distribution and
// persisted to market_score_distribution by the aggregates pass.
export interface ScoreBandCuts { strong: number; moderate: number; watch: number }
export function percentileBandCuts(scores: number[]): ScoreBandCuts {
  const vals = scores.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const at = (topPct: number) => {
    if (!vals.length) return SCORE_BAND_STRONG;
    const idx = clamp(Math.floor((1 - topPct) * (vals.length - 1)), 0, vals.length - 1);
    return vals[idx];
  };
  return { strong: at(0.02), moderate: at(0.10), watch: at(0.25) };
}

// Rebuild the raw 0..1 value each bucket carried, plus the adjustments applied
// after the buckets (penalties, regime / fundamental multipliers). Stored on
// market_score_history.raw_buckets so re-weighting a snapshot reproduces the
// live post-penalty score exactly instead of comparing a pre-penalty number
// against post-penalty thresholds. Shared by the live pipeline and the replay
// backfill: two copies drifted, and the replay wrote none at all.
export function v4RawDetail(v4: {
  buckets: Record<string, number>;
  coverage: Record<string, number>;
  components: Record<string, number>;
  penalties: Record<string, number>;
  rawBeforePenalty: number | null;
  score: number | null;
}): Record<string, unknown> {
  const coverShare = Number(v4.components?.coverage_share ?? 0);
  const scale = coverShare > 0 ? 1 / coverShare : 1;
  const raw: Record<string, number> = {};
  for (const [name, w] of Object.entries(V4_WEIGHTS)) {
    const pts = Number(v4.buckets?.[name] ?? 0);
    const eff = w * scale;
    raw[name] = eff > 0 ? Math.round(clamp(pts / eff, 0, 1) * 1000) / 1000 : 0;
  }
  const penaltyTotal = Object.values(v4.penalties ?? {})
    .reduce((a, b) => a + Number(b ?? 0), 0);
  return {
    raw,
    penalty_total: Math.round(penaltyTotal * 10) / 10,
    penalties: v4.penalties ?? {},
    regime_mult: Number(v4.components?.regime_mult ?? 1),
    fund_mult: Number(v4.components?.fundamental_mult ?? 1),
    coverage_share: coverShare,
    raw_before_penalty: v4.rawBeforePenalty,
    score: v4.score,
  };
}
