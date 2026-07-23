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
      relVolume: 3,
      rsi14: 62,
      pctFrom52wHigh: -1,
      macdHistRising: true,
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
    };
    const weakCtx: MarketContext = {
      sectorStrength: 0.1,
      regime: "bearish",
      relStrengthNifty: -15,
      deliveryPct: 10,
    };
    const s = breakoutScore(strong, strongCtx).score;
    const w = breakoutScore(weak, weakCtx).score;
    expect(s).toBeGreaterThan(75);
    expect(w).toBeLessThan(25);
  });

  it("degrades gracefully when delivery % is unavailable", () => {
    const withD = breakoutScore(baseSnap, { ...neutralCtx, deliveryPct: 60 });
    const withoutD = breakoutScore(baseSnap, neutralCtx);
    expect(withD.score).toBeGreaterThanOrEqual(withoutD.score);
    expect(withoutD.components.delivery).toBe(0);
  });

  it("penalizes overbought RSI", () => {
    const sweet = breakoutScore({ ...baseSnap, rsi14: 62 }, neutralCtx);
    const hot = breakoutScore({ ...baseSnap, rsi14: 85 }, neutralCtx);
    expect(sweet.components.rsi).toBe(10);
    expect(hot.components.rsi).toBe(0);
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
