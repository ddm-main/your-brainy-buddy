import { describe, it, expect } from "vitest";
import { holdingPnl, positionPnl, getTrustedDayChange, sumNullable, quoteKey } from "../src/lib/market/pnl";
import type { Quote } from "../src/lib/market/types";

const quote = (overrides: Partial<Quote> = {}): Quote => ({
  symbol: "FOO", exchange: "NSE", ltp: 120, previous_close: 110, change_pct: 9.09, day_change: 10,
  ...overrides,
});

describe("holdingPnl — percentage sign matches the ₹ figure regardless of quantity's sign", () => {
  it("long holding: gain shows positive ₹ and positive %", () => {
    const r = holdingPnl({ quantity: 10, avgPrice: 100, quote: quote() });
    expect(r.totalPnl).toBe(200); // (120*10) - (100*10)
    expect(r.totalPnlPct).toBeCloseTo(20, 5);
    expect(r.todayPnl).toBe(100); // dayChange(10) * qty(10)
    expect(r.todayPnlPct).toBeCloseTo((100 / 1100) * 100, 5);
  });

  it("long holding: loss shows negative ₹ and negative %", () => {
    const r = holdingPnl({ quantity: 10, avgPrice: 100, quote: quote({ ltp: 90, previous_close: 95 }) });
    expect(r.totalPnl).toBe(-100);
    expect(r.totalPnlPct).toBeCloseTo(-10, 5);
  });

  it("negative-quantity (short) holding: price rise is a loss — ₹ and % must agree in sign", () => {
    // Regression case: previously totalPnlPct divided by the signed `invested`
    // (-1000), flipping the sign relative to the correctly-signed ₹ totalPnl.
    const r = holdingPnl({ quantity: -10, avgPrice: 100, quote: quote({ ltp: 120, previous_close: 110 }) });
    expect(r.totalPnl).toBe(-200); // current(-1200) - invested(-1000)
    expect(r.totalPnlPct).toBeCloseTo(-20, 5); // must be negative, matching the ₹ loss
    expect(r.todayPnl).toBe(-100); // dayChange(10) * qty(-10)
    expect(r.todayPnlPct).toBeLessThan(0); // must be negative, matching the ₹ loss
  });

  it("negative-quantity (short) holding: price fall is a gain — ₹ and % must agree in sign", () => {
    const r = holdingPnl({ quantity: -10, avgPrice: 100, quote: quote({ ltp: 80, previous_close: 90 }) });
    expect(r.totalPnl).toBe(200); // current(-800) - invested(-1000)
    expect(r.totalPnlPct).toBeCloseTo(20, 5);
  });

  it("avgPrice=0 (bad data): totalPnlPct is null, not a misleading 0%", () => {
    // Regression case: previously `invested ? ... : 0` showed "0.00%" next to
    // a nonzero ₹ P&L — self-contradictory. Must be null ("unknown"), matching
    // this function's own "unknown ≠ 0" contract.
    const r = holdingPnl({ quantity: 10, avgPrice: 0, quote: quote({ ltp: 120 }) });
    expect(r.invested).toBe(0);
    expect(r.totalPnl).toBe(1200);
    expect(r.totalPnlPct).toBeNull();
  });

  it("unresolved quote (no ltp): everything price-derived is null, never 0", () => {
    const r = holdingPnl({ quantity: 10, avgPrice: 100, quote: undefined });
    expect(r.current).toBeNull();
    expect(r.totalPnl).toBeNull();
    expect(r.totalPnlPct).toBeNull();
    expect(r.todayPnl).toBeNull();
    expect(r.todayPnlPct).toBeNull();
  });

  it("stale quote: todayPnl is null (can't trust the day's move) even though ltp resolves", () => {
    const r = holdingPnl({ quantity: 10, avgPrice: 100, quote: quote({ stale: true }) });
    expect(r.current).not.toBeNull(); // ltp itself still resolves the position's current value
    expect(r.todayPnl).toBeNull(); // but "today's move" is untrustworthy per getTrustedDayChange
  });
});

describe("positionPnl — direction-based sign, for contrast/regression-guard", () => {
  it("short position: price rise is a loss, price fall is a gain", () => {
    const rise = positionPnl({ quantity: 10, entryPrice: 100, side: "short", quote: quote({ ltp: 120 }) });
    expect(rise.unrealized).toBe(-200);
    expect(rise.unrealizedPct).toBeCloseTo(-20, 5);
    const fall = positionPnl({ quantity: 10, entryPrice: 100, side: "short", quote: quote({ ltp: 80 }) });
    expect(fall.unrealized).toBe(200);
    expect(fall.unrealizedPct).toBeCloseTo(20, 5);
  });
});

describe("getTrustedDayChange", () => {
  it("prefers ltp - previous_close over the raw day_change field", () => {
    expect(getTrustedDayChange(quote({ ltp: 120, previous_close: 110, day_change: 999 }))).toBe(10);
  });
  it("returns null for a stale quote", () => {
    expect(getTrustedDayChange(quote({ stale: true }))).toBeNull();
  });
  it("returns null for a missing quote", () => {
    expect(getTrustedDayChange(undefined)).toBeNull();
  });
});

describe("sumNullable", () => {
  it("sums usable values, ignoring null/NaN", () => {
    expect(sumNullable([10, null, -5, NaN])).toBe(5);
  });
  it("returns null (not 0) when every value is unusable", () => {
    expect(sumNullable([null, null])).toBeNull();
    expect(sumNullable([])).toBeNull();
  });
});

describe("quoteKey", () => {
  it("normalizes exchange:symbol consistently regardless of case/whitespace", () => {
    expect(quoteKey(" nse ", " reliance ")).toBe("NSE:RELIANCE");
  });
});
