import { describe, it, expect } from "vitest";
import {
  breakoutScore,
  preBreakoutScore,
  classifyRegime,
  evaluateLiquidity,
  swingScore,
  intradayScore,
  breakoutFollowThroughScore,
  nextEpisodeStatus,
  BREAKOUT_QUALIFY_SCORE,
  EXTEND_PCT,
  FAIL_PCT,
  COOL_DAYS,
  MAX_TRACK_DAYS,
  LIQUIDITY_MIN_PRICE,
  LIQUIDITY_MIN_MARKET_CAP_CR,
  LIQUIDITY_MIN_TURNOVER_CR,
  type MarketContext,
  type LiquidityGate,
  type AdvancedSignals,
} from "../supabase/functions/_shared/market/scoring";
import type { IndicatorSnapshot, WeeklySnapshot } from "../supabase/functions/_shared/market/indicators";

const baseSnap: IndicatorSnapshot = {
  close: 100,
  changePct: 1,
  volume: 1000,
  volAvg20: 1000,
  volAvg30: 1000,
  relVolume: 1,
  ema20: 98,
  ema50: 95,
  ema100: 92,
  ema200: 90,
  rsi14: 60,
  macd: 1,
  macdSignal: 0.5,
  macdHist: 0.5,
  adx14: 25,
  atr14: 2,
  atrPct: 2,
  bbUpper: 105,
  bbLower: 95,
  bbWidth: 0.1,
  bbSqueeze: false,
  atrContracting: false,
  high52w: 110,
  low52w: 70,
  pctFrom52wHigh: -9.1,
  aboveEma200: true,
  emaAligned: true,
  higherLows: false,
  support: 95,
  resistance: 108,
  nearResistance: false,
  macdHistRising: true,
  rollingHigh20: null,
  rollingHigh55: null,
  obvSlope20: null,
  baseTightness: null,
  baseDepthPct: null,
  baseDurationDays: null,
  rsPercentile: null,
  closeInRangePct: null,
  breakoutFreshnessDays: null,
  ema20Series: [],
  ema50Series: [],
  ema200Series: [],
};

const neutralCtx: MarketContext = {
  sectorStrength: null,
  regime: "neutral",
  relStrengthNifty: null,
  deliveryPct: null,
};

describe("breakoutScore", () => {
  it("is bounded 0..100 and returns components", () => {
    const r = breakoutScore(baseSnap, neutralCtx);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(Object.keys(r.components).length).toBeGreaterThan(5);
  });

  it("scores a textbook breakout much higher than a weak stock", () => {
    const strong: IndicatorSnapshot = {
      ...baseSnap,
      close: 105,
      rollingHigh20: 100,
      atr14: 2,
      relVolume: 3,
      rsi14: 62,
      adx14: 32,
      pctFrom52wHigh: -1,
      macdHistRising: true,
      obvSlope20: 0.08,
      baseTightness: 0.02,
      baseDepthPct: 6,
      baseDurationDays: 30,
      closeInRangePct: 90,
      breakoutFreshnessDays: 0,
      rsPercentile: 90,
    };
    const strongCtx: MarketContext = {
      sectorStrength: 0.9,
      regime: "bullish",
      relStrengthNifty: 12,
      deliveryPct: 55,
    };
    const weak: IndicatorSnapshot = {
      ...baseSnap,
      relVolume: 0.6,
      rsi14: 35,
      aboveEma200: false,
      emaAligned: false,
      macd: -1,
      macdSignal: 0,
      macdHistRising: false,
      pctFrom52wHigh: -40,
      rsPercentile: 10,
    };
    const weakCtx: MarketContext = {
      sectorStrength: 0.1,
      regime: "bearish",
      relStrengthNifty: -15,
      deliveryPct: 10,
    };
    const s = breakoutScore(strong, strongCtx).score;
    const w = breakoutScore(weak, weakCtx).score;
    expect(s).toBeGreaterThan(60);
    expect(w).toBeLessThan(25);
    expect(s - w).toBeGreaterThan(40);
  });

  it("degrades gracefully when delivery % is unavailable", () => {
    const withD = breakoutScore(baseSnap, { ...neutralCtx, deliveryPct: 60 });
    const withoutD = breakoutScore(baseSnap, neutralCtx);
    expect(withD.score).toBeGreaterThanOrEqual(withoutD.score);
    expect(withoutD.components.delivery).toBe(0);
  });

  it("penalizes overbought RSI relative to a healthy zone", () => {
    const sweet = breakoutScore({ ...baseSnap, rsi14: 62 }, neutralCtx);
    const hot = breakoutScore({ ...baseSnap, rsi14: 88 }, neutralCtx);
    expect(sweet.components.rsi).toBeGreaterThan(hot.components.rsi);
    expect(hot.components.rsi).toBeLessThanOrEqual(2);
  });

  it("applies an over-extension penalty when price is many ATRs above EMA20", () => {
    // 6 ATRs above EMA20 → full -15 penalty
    const extended = breakoutScore(
      { ...baseSnap, close: 100, ema20: 88, atr14: 2 },
      neutralCtx,
    );
    expect(extended.components.penalty_overextension).toBeLessThan(0);
  });

  it("floors total at 0 even under heavy penalties", () => {
    const weakExtended = breakoutScore(
      { ...baseSnap, close: 100, ema20: 80, atr14: 2, relVolume: 0.3, rsi14: 30, aboveEma200: false, emaAligned: false, macd: -1, macdSignal: 0, macdHistRising: false, pctFrom52wHigh: -40 },
      { ...neutralCtx, regime: "bearish", relStrengthNifty: -20 },
    );
    expect(weakExtended.score).toBeGreaterThanOrEqual(0);
  });

  it("rewards a real close-above-pivot trigger more than mere 52w-high proximity", () => {
    const nearHigh = breakoutScore(
      { ...baseSnap, pctFrom52wHigh: -1, rollingHigh20: null, rollingHigh55: null },
      neutralCtx,
    );
    const brokeOut = breakoutScore(
      { ...baseSnap, close: 102, atr14: 2, rollingHigh20: 100, rollingHigh55: 100, pctFrom52wHigh: -1 },
      neutralCtx,
    );
    expect(brokeOut.components.trigger).toBeGreaterThan(nearHigh.components.trigger);
  });

  it("bearish regime dampens the breakout score", () => {
    const bull = breakoutScore(baseSnap, { ...neutralCtx, regime: "bullish" }).score;
    const bear = breakoutScore(baseSnap, { ...neutralCtx, regime: "bearish" }).score;
    expect(bull).toBeGreaterThan(bear);
  });
});

describe("preBreakoutScore", () => {
  it("rewards squeeze + higher lows + near resistance", () => {
    const coiled: IndicatorSnapshot = {
      ...baseSnap,
      bbSqueeze: true,
      atrContracting: true,
      higherLows: true,
      nearResistance: true,
      relVolume: 0.8,
    };
    const r = preBreakoutScore(coiled, neutralCtx);
    expect(r.score).toBe(100);
  });

  it("dampens in a bearish regime", () => {
    const coiled: IndicatorSnapshot = {
      ...baseSnap,
      bbSqueeze: true,
      atrContracting: true,
      higherLows: true,
      nearResistance: true,
      relVolume: 0.8,
    };
    const bear = preBreakoutScore(coiled, { ...neutralCtx, regime: "bearish" });
    expect(bear.score).toBeLessThan(100);
  });

  it("scores an extended noisy stock low", () => {
    const r = preBreakoutScore(baseSnap, neutralCtx); // no squeeze/HL/resistance
    expect(r.score).toBeLessThanOrEqual(20);
  });
});

describe("breakoutScore v2 components", () => {
  it("rewards fresh breakouts above rolling high with tight base", () => {
    const fresh = breakoutScore(
      { ...baseSnap, close: 105, rollingHigh20: 100, atr14: 2, baseTightness: 0.02, baseDepthPct: 6, baseDurationDays: 30, closeInRangePct: 90, breakoutFreshnessDays: 0, obvSlope20: 0.05, rsPercentile: 85 },
      neutralCtx,
    );
    const stale = breakoutScore(
      { ...baseSnap, close: 105, rollingHigh20: 100, atr14: 2, baseTightness: 0.09, baseDepthPct: 25, baseDurationDays: 5, closeInRangePct: 30, breakoutFreshnessDays: 6, obvSlope20: -0.05, rsPercentile: 20 },
      neutralCtx,
    );
    expect(fresh.score).toBeGreaterThan(stale.score);
  });
  it("stays bounded 0..100 with all v2 inputs populated", () => {
    const r = breakoutScore(
      { ...baseSnap, rollingHigh20: 99, obvSlope20: 0.1, baseTightness: 0.03, baseDepthPct: 10, baseDurationDays: 25, rsPercentile: 75, closeInRangePct: 80, breakoutFreshnessDays: 1 },
      neutralCtx,
    );
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});


describe("classifyRegime", () => {
  it("bullish when breadth strong", () => {
    expect(classifyRegime(70, 60)).toBe("bullish");
  });
  it("bearish when breadth weak", () => {
    expect(classifyRegime(30, 45)).toBe("bearish");
  });
  it("neutral otherwise and on nulls", () => {
    expect(classifyRegime(50, 50)).toBe("neutral");
    expect(classifyRegime(null, null)).toBe("neutral");
  });
});

// ============================================================================
// v3 — liquidity gate + swingScore/intradayScore. breakoutScore/preBreakoutScore
// above are untouched; these cover the additive scorers only.
// ============================================================================

describe("evaluateLiquidity", () => {
  it("passes a liquid large-cap", () => {
    const r = evaluateLiquidity({ close: 500, marketCapCr: 5000, avgTurnoverCr: 10 });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("flags a penny stock on every axis at once", () => {
    const r = evaluateLiquidity({ close: 5, marketCapCr: 20, avgTurnoverCr: 0.1 });
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(3);
  });

  it("flags price alone when cap/turnover are otherwise fine", () => {
    const r = evaluateLiquidity({ close: LIQUIDITY_MIN_PRICE - 1, marketCapCr: 5000, avgTurnoverCr: 10 });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([`price below ₹${LIQUIDITY_MIN_PRICE}`]);
  });

  it("treats unknown (null) inputs as failing, not liquid-by-default", () => {
    const r = evaluateLiquidity({ close: null, marketCapCr: null, avgTurnoverCr: null });
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(3);
  });

  it("passes exactly at the threshold (>=, not >)", () => {
    const r = evaluateLiquidity({
      close: LIQUIDITY_MIN_PRICE,
      marketCapCr: LIQUIDITY_MIN_MARKET_CAP_CR,
      avgTurnoverCr: LIQUIDITY_MIN_TURNOVER_CR,
    });
    expect(r.ok).toBe(true);
  });
});

const okLiquidity: LiquidityGate = { ok: true, reasons: [] };
const gatedLiquidity: LiquidityGate = { ok: false, reasons: ["price below ₹20", "market cap below ₹100Cr"] };

const constructiveWeekly: WeeklySnapshot = {
  closeW: 110, ema20W: 100, rsi14W: 60, aboveEma20W: true, trendUpW: true, higherLowsW: true, barsW: 30,
};

const fullAdv: AdvancedSignals = {
  vwapRel: 0.02, supertrendDir: 1, mfi14: 70, percentB: 0.9,
  patterns: {
    bullishEngulfing: true, hammer: false, doji: false,
    cupAndHandle: true, flag: true, ascendingTriangle: true,
    bearishEngulfing: false, shootingStar: false,
  },
};

describe("swingScore", () => {
  it("gates illiquid stocks to 0 with reasons surfaced, never silently included", () => {
    const r = swingScore({ s: baseSnap, ctx: neutralCtx, weekly: null, liquidity: gatedLiquidity });
    expect(r.score).toBe(0);
    expect(r.liquidityOk).toBe(false);
    expect(r.liquidityReasons).toEqual(gatedLiquidity.reasons);
  });

  it("is bounded 0..100 for a liquid stock with every input populated", () => {
    const r = swingScore({
      s: { ...baseSnap, close: 105, rollingHigh20: 100, baseTightness: 0.02, baseDepthPct: 6, baseDurationDays: 30, rsPercentile: 90 },
      ctx: { sectorStrength: 0.9, regime: "bullish", relStrengthNifty: 12, deliveryPct: null },
      weekly: constructiveWeekly,
      adv: fullAdv,
      liquidity: okLiquidity,
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.liquidityOk).toBe(true);
  });

  it("weekly confluence alone lifts the score, all else held equal", () => {
    const noWeekly = swingScore({ s: baseSnap, ctx: neutralCtx, weekly: null, liquidity: okLiquidity });
    const withWeekly = swingScore({ s: baseSnap, ctx: neutralCtx, weekly: constructiveWeekly, liquidity: okLiquidity });
    expect(withWeekly.score).toBeGreaterThan(noWeekly.score);
  });

  it("scores a strong multi-timeframe swing setup much higher than a weak one", () => {
    const strong = swingScore({
      s: { ...baseSnap, close: 105, rollingHigh20: 100, atr14: 2, baseTightness: 0.02, baseDepthPct: 6, baseDurationDays: 30, rsPercentile: 90, adx14: 32, macdHistRising: true },
      ctx: { sectorStrength: 0.9, regime: "bullish", relStrengthNifty: 12, deliveryPct: null },
      weekly: constructiveWeekly,
      adv: fullAdv,
      liquidity: okLiquidity,
    });
    const weak = swingScore({
      s: { ...baseSnap, rsi14: 35, aboveEma200: false, emaAligned: false, macd: -1, macdSignal: 0, macdHistRising: false, pctFrom52wHigh: -40, rsPercentile: 10 },
      ctx: { sectorStrength: 0.1, regime: "bearish", relStrengthNifty: -15, deliveryPct: null },
      weekly: null,
      liquidity: okLiquidity,
    });
    expect(strong.score - weak.score).toBeGreaterThan(40);
  });
});

describe("intradayScore", () => {
  it("gates illiquid stocks to 0 with reasons surfaced", () => {
    const r = intradayScore({ s: baseSnap, ctx: neutralCtx, liquidity: gatedLiquidity, relVolumeSoFar: null, gapPct: null });
    expect(r.score).toBe(0);
    expect(r.liquidityOk).toBe(false);
    expect(r.liquidityReasons).toEqual(gatedLiquidity.reasons);
  });

  it("is bounded 0..100 with every input populated", () => {
    const r = intradayScore({
      s: { ...baseSnap, close: 104, rollingHigh20: 100 },
      ctx: { sectorStrength: 0.7, regime: "bullish", relStrengthNifty: 8, deliveryPct: null },
      adv: fullAdv,
      liquidity: okLiquidity,
      relVolumeSoFar: 4,
      gapPct: 2.5,
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("a live volume surge beats a quiet session", () => {
    const surge = intradayScore({ s: baseSnap, ctx: neutralCtx, liquidity: okLiquidity, relVolumeSoFar: 4, gapPct: 2 });
    const quiet = intradayScore({ s: baseSnap, ctx: neutralCtx, liquidity: okLiquidity, relVolumeSoFar: 0.5, gapPct: 0 });
    expect(surge.score).toBeGreaterThan(quiet.score);
  });

  it("time-of-day relVolumeSoFar overrides the snapshot's stale full-day relVolume", () => {
    // baseSnap.relVolume is 1 (flat) — a live time-of-day read saying today is
    // already running at 4x must move the score, proving relVolumeSoFar wins
    // over falling back to s.relVolume.
    const withLiveRead = intradayScore({ s: baseSnap, ctx: neutralCtx, liquidity: okLiquidity, relVolumeSoFar: 4, gapPct: null });
    const withoutLiveRead = intradayScore({ s: baseSnap, ctx: neutralCtx, liquidity: okLiquidity, relVolumeSoFar: null, gapPct: null });
    expect(withLiveRead.score).toBeGreaterThan(withoutLiveRead.score);
  });
});

// ============================================================================
// Breakout tracking — follow-through score + episode lifecycle transitions.
// ============================================================================

describe("breakoutFollowThroughScore", () => {
  it("rewards a pick following through near its peak with a rising score", () => {
    const r = breakoutFollowThroughScore({
      entryClose: 100, currentClose: 109, peakClose: 110,
      daysTracked: 3, belowThresholdDays: 0, scoreTrend: [70, 75, 82], lastScore: 82,
    });
    expect(r.score).toBeGreaterThan(75);
  });

  it("punishes a pick that ran up then gave the whole gain back", () => {
    const held = breakoutFollowThroughScore({
      entryClose: 100, currentClose: 110, peakClose: 110,
      daysTracked: 4, belowThresholdDays: 0, scoreTrend: [72, 74, 76], lastScore: 76,
    });
    const gaveBack = breakoutFollowThroughScore({
      entryClose: 100, currentClose: 100.5, peakClose: 110,
      daysTracked: 4, belowThresholdDays: 0, scoreTrend: [72, 74, 76], lastScore: 76,
    });
    expect(gaveBack.score).toBeLessThan(held.score);
    expect(gaveBack.components.hold_peak).toBeLessThan(held.components.hold_peak);
  });

  it("applies a drawdown penalty below entry", () => {
    const r = breakoutFollowThroughScore({
      entryClose: 100, currentClose: 96, peakClose: 102,
      daysTracked: 5, belowThresholdDays: 2, scoreTrend: [72, 65, 58], lastScore: 58,
    });
    expect(r.components.penalty_drawdown).toBeLessThan(0);
  });

  it("is bounded 0..100", () => {
    const hot = breakoutFollowThroughScore({
      entryClose: 100, currentClose: 130, peakClose: 130,
      daysTracked: 1, belowThresholdDays: 0, scoreTrend: [90, 95], lastScore: 95,
    });
    const dead = breakoutFollowThroughScore({
      entryClose: 100, currentClose: 80, peakClose: 101,
      daysTracked: 14, belowThresholdDays: 5, scoreTrend: [70, 40, 20], lastScore: 20,
    });
    expect(hot.score).toBeLessThanOrEqual(100);
    expect(dead.score).toBeGreaterThanOrEqual(0);
  });
});

describe("nextEpisodeStatus", () => {
  const open = { status: "active" as const, entryClose: 100, daysTracked: 2, belowThresholdDays: 0 };

  it("fails an episode that draws down past FAIL_PCT below entry", () => {
    const r = nextEpisodeStatus({ ...open, close: 100 - FAIL_PCT - 1, score: 75 });
    expect(r.status).toBe("failed");
  });

  it("promotes to extended on strong follow-through with a holding score", () => {
    const r = nextEpisodeStatus({ ...open, close: 100 + EXTEND_PCT + 1, score: BREAKOUT_QUALIFY_SCORE });
    expect(r.status).toBe("extended");
  });

  it("cools after COOL_DAYS of sub-threshold score without failing", () => {
    const r = nextEpisodeStatus({
      status: "active", entryClose: 100, close: 101, score: BREAKOUT_QUALIFY_SCORE - 5,
      daysTracked: 4, belowThresholdDays: COOL_DAYS - 1,
    });
    expect(r.status).toBe("cooled");
    expect(r.belowThresholdDays).toBe(COOL_DAYS);
  });

  it("recovers a cooled episode back to active once score clears threshold", () => {
    const r = nextEpisodeStatus({
      status: "cooled", entryClose: 100, close: 102, score: BREAKOUT_QUALIFY_SCORE + 2,
      daysTracked: 6, belowThresholdDays: 4,
    });
    expect(r.status).toBe("active");
    expect(r.belowThresholdDays).toBe(0);
  });

  it("auto-closes after MAX_TRACK_DAYS", () => {
    const r = nextEpisodeStatus({
      status: "extended", entryClose: 100, close: 108, score: 75,
      daysTracked: MAX_TRACK_DAYS - 1, belowThresholdDays: 0,
    });
    expect(r.status).toBe("closed");
  });

  it("keeps terminal states terminal", () => {
    const failed = nextEpisodeStatus({ status: "failed", entryClose: 100, close: 120, score: 90, daysTracked: 3, belowThresholdDays: 0 });
    expect(failed.status).toBe("failed");
  });

  it("resets the sub-threshold counter when the score recovers above threshold", () => {
    const r = nextEpisodeStatus({ ...open, close: 103, score: BREAKOUT_QUALIFY_SCORE + 1, belowThresholdDays: 2 });
    expect(r.belowThresholdDays).toBe(0);
  });
});
