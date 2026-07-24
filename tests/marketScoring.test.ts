import { describe, it, expect } from "vitest";
import {
  breakoutScore,
  preBreakoutScore,
  classifyRegime,
  type MarketContext,
} from "../supabase/functions/_shared/market/scoring";
import type { IndicatorSnapshot } from "../supabase/functions/_shared/market/indicators";

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
