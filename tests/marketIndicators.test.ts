import { describe, it, expect } from "vitest";
import {
  sma,
  ema,
  rsi,
  macd,
  atr,
  bollinger,
  rollingHighLow,
  relVolume,
  higherLows,
  supportResistance,
  computeSnapshot,
  type Candle,
} from "../supabase/functions/_shared/market/indicators";
import { totp, base32Decode } from "../supabase/functions/_shared/market/totp";

function mkCandles(closes: number[], volume = 1000): Candle[] {
  return closes.map((c, i) => ({
    time: 1700000000 + i * 86400,
    open: c * 0.995,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume,
  }));
}

describe("sma", () => {
  it("computes a simple moving average", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([null, null, 2, 3, 4]);
  });
});

describe("ema", () => {
  it("seeds with SMA and applies the multiplier", () => {
    // period 3, k = 0.5. Seed = avg(2,4,6) = 4. Next: 8*0.5 + 4*0.5 = 6.
    const out = ema([2, 4, 6, 8], 3);
    expect(out[2]).toBeCloseTo(4);
    expect(out[3]).toBeCloseTo(6);
  });
  it("returns nulls when series shorter than period", () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });
});

describe("rsi (Wilder)", () => {
  it("matches the classic Wilder worked example", () => {
    // Well-known series used in RSI tutorials (14-period first RSI ≈ 70.53)
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28,
    ];
    const out = rsi(closes, 14);
    expect(out[14]).toBeCloseTo(70.46, 0);
  });
  it("is 100 when there are no losses", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const out = rsi(closes, 14);
    expect(out[19]).toBe(100);
  });
});

describe("macd", () => {
  it("macd = fastEMA - slowEMA at defined points", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const { macd: line, signal, hist } = macd(closes);
    const lastIdx = closes.length - 1;
    expect(line[lastIdx]).not.toBeNull();
    expect(signal[lastIdx]).not.toBeNull();
    expect(hist[lastIdx]).toBeCloseTo((line[lastIdx] as number) - (signal[lastIdx] as number));
  });
});

describe("atr", () => {
  it("equals high-low for constant-range candles", () => {
    // All candles: high = c*1.01, low = c*0.99 with c=100 → TR = 2 always
    const candles = mkCandles(Array(30).fill(100));
    const out = atr(candles, 14);
    expect(out[20]).toBeCloseTo(2, 5);
  });
});

describe("bollinger", () => {
  it("has zero width for a flat series", () => {
    const { upper, lower, width } = bollinger(Array(25).fill(50), 20, 2);
    expect(upper[24]).toBeCloseTo(50);
    expect(lower[24]).toBeCloseTo(50);
    expect(width[24]).toBeCloseTo(0);
  });
  it("expands with volatility", () => {
    const vals = Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? 40 : 60));
    const { width } = bollinger(vals, 20, 2);
    expect(width[24]).toBeGreaterThan(0.5);
  });
});

describe("rollingHighLow", () => {
  it("finds the window extremes", () => {
    const candles = mkCandles([10, 50, 30, 20]);
    const { high, low } = rollingHighLow(candles, 252);
    expect(high).toBeCloseTo(50 * 1.01);
    expect(low).toBeCloseTo(10 * 0.99);
  });
});

describe("relVolume", () => {
  it("is today's volume over the prior 20-day average", () => {
    const volumes = [...Array(20).fill(1000), 3000];
    expect(relVolume(volumes, 20)).toBeCloseTo(3);
  });
  it("null when insufficient history", () => {
    expect(relVolume([1, 2, 3], 20)).toBeNull();
  });
});

describe("higherLows", () => {
  it("detects ascending swing lows", () => {
    // Build a zigzag with rising troughs: 100→90→110→95→115→101→120
    const lows: number[] = [];
    const legs = [
      [100, 90], [90, 110], [110, 95], [95, 115], [115, 101], [101, 120],
    ];
    for (const [from, to] of legs) {
      const step = (to - from) / 5;
      for (let i = 0; i < 5; i++) lows.push(from + step * i);
    }
    expect(higherLows(lows, 40, 2)).toBe(true);
  });
  it("false for a downtrend", () => {
    const lows = Array.from({ length: 40 }, (_, i) => 200 - i * 2 + (i % 3));
    expect(higherLows(lows, 40, 3)).toBe(false);
  });
});

describe("supportResistance", () => {
  it("resistance above close, support below", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 15);
    const candles = mkCandles(closes);
    const { support, resistance } = supportResistance(candles, 60);
    const lastClose = candles[candles.length - 1].close;
    if (resistance != null) expect(resistance).toBeGreaterThan(lastClose);
    if (support != null) expect(support).toBeLessThan(lastClose);
  });
});

describe("computeSnapshot", () => {
  it("uses the arithmetic average of the prior 30 volumes, excluding today", () => {
    const candles = mkCandles(Array.from({ length: 31 }, (_, i) => 100 + i));
    candles.forEach((c, i) => { c.volume = i < 30 ? i + 1 : 1_000_000; });
    const snap = computeSnapshot(candles);
    expect(snap?.volAvg30).toBe(15.5);
  });
  it("returns a full snapshot for a real-shaped series", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 * Math.exp(0.001 * i) + Math.sin(i / 7) * 3);
    const candles = mkCandles(closes);
    const snap = computeSnapshot(candles);
    expect(snap).not.toBeNull();
    expect(snap!.close).toBeCloseTo(closes[closes.length - 1]);
    expect(snap!.ema200).not.toBeNull();
    expect(snap!.rsi14).toBeGreaterThan(0);
    expect(snap!.aboveEma200).toBe(true); // steady uptrend
    expect(snap!.high52w).toBeGreaterThan(0);
    expect(snap!.ema20Series.length).toBe(candles.length);
  });
  it("null for too-short series", () => {
    expect(computeSnapshot(mkCandles([1, 2, 3]))).toBeNull();
  });
});

describe("totp (RFC 6238 SHA-1 vectors)", () => {
  // RFC 6238 Appendix B: secret "12345678901234567890" = base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ, 8 digits
  const SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  it("decodes base32", () => {
    const bytes = base32Decode(SECRET_B32);
    expect(new TextDecoder().decode(bytes)).toBe("12345678901234567890");
  });
  it("matches vector T=59 → 94287082", async () => {
    expect(await totp(SECRET_B32, { timeMs: 59_000, digits: 8 })).toBe("94287082");
  });
  it("matches vector T=1111111109 → 07081804", async () => {
    expect(await totp(SECRET_B32, { timeMs: 1111111109_000, digits: 8 })).toBe("07081804");
  });
  it("6-digit codes are zero-padded strings", async () => {
    const code = await totp(SECRET_B32, { timeMs: 59_000 });
    expect(code).toMatch(/^\d{6}$/);
  });
});
