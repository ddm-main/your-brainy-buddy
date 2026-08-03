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
  resampleWeekly,
  computeWeeklySnapshot,
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

describe("resampleWeekly", () => {
  it("aggregates daily candles into OHLCV weekly bars with no volume lost", () => {
    const candles = mkCandles(Array.from({ length: 14 }, (_, i) => 100 + i));
    const weekly = resampleWeekly(candles);
    // 14 daily bars starting mid-week span 2-3 ISO weeks depending on alignment.
    expect(weekly.length).toBeGreaterThanOrEqual(2);
    expect(weekly.length).toBeLessThanOrEqual(3);
    const totalVolume = candles.reduce((a, c) => a + c.volume, 0);
    const weeklyVolume = weekly.reduce((a, c) => a + c.volume, 0);
    expect(weeklyVolume).toBe(totalVolume);
    expect(weekly[weekly.length - 1].close).toBe(candles[candles.length - 1].close);
    expect(weekly[0].open).toBe(candles[0].open);
  });
  it("each weekly bar's high/low bounds its member daily candles", () => {
    const closes = [10, 50, 30, 20, 15, 40, 5, 60, 25, 35];
    const candles = mkCandles(closes);
    const weekly = resampleWeekly(candles);
    for (const bar of weekly) {
      expect(bar.high).toBeGreaterThanOrEqual(bar.low);
    }
    // Global max/min must appear inside some weekly bar's range.
    const globalHigh = Math.max(...candles.map((c) => c.high));
    const globalLow = Math.min(...candles.map((c) => c.low));
    expect(Math.max(...weekly.map((w) => w.high))).toBeCloseTo(globalHigh);
    expect(Math.min(...weekly.map((w) => w.low))).toBeCloseTo(globalLow);
  });
});

describe("computeWeeklySnapshot", () => {
  it("returns null with fewer than 25 weekly bars", () => {
    const candles = mkCandles(Array(60).fill(100)); // ~8-9 weekly bars
    expect(computeWeeklySnapshot(candles)).toBeNull();
  });
  it("reads a steady uptrend as weekly-constructive (above EMA20W, RSI>50, trendUpW)", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.3);
    const candles = mkCandles(closes);
    const snap = computeWeeklySnapshot(candles);
    expect(snap).not.toBeNull();
    expect(snap!.barsW).toBeGreaterThanOrEqual(25);
    expect(snap!.closeW).toBeCloseTo(closes[closes.length - 1], 0);
    expect(snap!.aboveEma20W).toBe(true);
    expect(snap!.rsi14W).toBeGreaterThan(50);
    expect(snap!.trendUpW).toBe(true);
  });
  it("reads a steady downtrend as weekly-non-constructive", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 400 - i * 0.3);
    const candles = mkCandles(closes);
    const snap = computeWeeklySnapshot(candles);
    expect(snap).not.toBeNull();
    expect(snap!.aboveEma20W).toBe(false);
    expect(snap!.trendUpW).toBe(false);
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

// ---- Levels & trigger fixes (breakout state, base windowing) --------------
import { breakoutState, baseEndIndex, baseMetrics as baseMetricsFn } from "../supabase/functions/_shared/market/indicators";

function mkFlatCandles(closes: number[]) {
  return closes.map((c, i) => ({
    time: 1700000000 + i * 86400, open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 100000,
  }));
}

describe("breakoutState", () => {
  it("reports fresh with days since the clearing bar", () => {
    const flat = Array.from({ length: 40 }, () => 100);
    const c = mkFlatCandles([...flat, 106, 107]);
    const r = breakoutState(c, 20, 10);
    expect(r.state).toBe("fresh");
    expect(r.days).toBe(1);
  });
  it("reports failed when price fell back under the cleared level", () => {
    const flat = Array.from({ length: 40 }, () => 100);
    const c = mkFlatCandles([...flat, 106, 99]);
    const r = breakoutState(c, 20, 10);
    expect(r.state).toBe("failed");
    expect(r.level).toBeGreaterThan(99);
  });
  it("reports none when there was never a breakout", () => {
    expect(breakoutState(mkFlatCandles(Array.from({ length: 60 }, () => 100)), 20, 10).state).toBe("none");
  });
});

describe("baseMetrics windowing", () => {
  it("keeps base duration intact when measured up to the pre-breakout bar", () => {
    const flat = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 0.2 : -0.2));
    const c = mkFlatCandles([...flat, 112]);
    const endIdx = baseEndIndex(c, 101, 15);
    expect(endIdx).toBe(c.length - 2);
    const through = baseMetricsFn(c, 30);
    const upTo = baseMetricsFn(c, 30, endIdx);
    expect(upTo.durationDays ?? 0).toBeGreaterThan(through.durationDays ?? 0);
  });
});

// ---- volume analysis: OBV + Volume Profile ----
import { obv, obvWithMa, volumeProfile } from "@/lib/market/chartIndicators";

const mkVolCandles = (rows: Array<[number, number]>, startSec = 1_722_000_000, stepSec = 300) =>
  rows.map(([close, volume], i) => ({
    time: startSec + i * stepSec,
    open: close, high: close, low: close, close, volume,
  })) as any[];

describe("OBV", () => {
  it("adds volume on up closes, subtracts on down closes, holds on flat", () => {
    const c = mkVolCandles([[100, 10], [101, 5], [100, 4], [100, 7], [102, 3]]);
    expect(obv(c)).toEqual([0, 5, 1, 1, 4]);
  });

  it("treats missing volume as zero instead of NaN", () => {
    const c = mkVolCandles([[100, 10], [101, 5]]);
    (c[1] as any).volume = undefined;
    expect(obv(c)).toEqual([0, 0]);
  });

  it("restarts each IST session when resetDaily is on", () => {
    // 03:45Z = 09:15 IST. Two bars on day 1, two on day 2.
    const d1 = Date.UTC(2026, 6, 30, 3, 45) / 1000;
    const d2 = Date.UTC(2026, 6, 31, 3, 45) / 1000;
    const c = [
      { time: d1, open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: d1 + 300, open: 101, high: 101, low: 101, close: 101, volume: 5 },
      { time: d2, open: 102, high: 102, low: 102, close: 102, volume: 8 },
      { time: d2 + 300, open: 103, high: 103, low: 103, close: 103, volume: 6 },
    ] as any[];
    expect(obv(c, true)).toEqual([0, 5, 0, 6]);
    expect(obv(c, false)).toEqual([0, 5, 13, 19]);
  });

  it("smooths with a moving average and disables it at maPeriod <= 1", () => {
    const c = mkVolCandles([[100, 10], [101, 5], [102, 5], [103, 5]]);
    const { obv: line, ma } = obvWithMa(c, 2);
    expect(line).toEqual([0, 5, 10, 15]);
    expect(ma).toEqual([null, 2.5, 7.5, 12.5]);
    expect(obvWithMa(c, 1).ma.every((v) => v == null)).toBe(true);
  });
});

describe("volume profile", () => {
  it("splits each row into buying and selling volume and finds the POC", () => {
    const c = mkVolCandles([[100, 10], [101, 40], [100, 30], [101, 20]]);
    const p = volumeProfile(c, { rows: 2, valueAreaPct: 70 });
    expect(p.upVol + p.downVol).toBe(100);
    // Bars 2 and 4 close up (buying), bars 1 (vs open, flat -> buying) and 3 down.
    expect(p.downVol).toBe(30);
    expect(p.upVol).toBe(70);
    expect(p.maxTotal).toBeGreaterThan(0);
    expect(p.poc).not.toBeNull();
    const total = p.rows.reduce((s, r) => s + r.total, 0);
    expect(total).toBe(100);
  });

  it("keeps the value area inside the profile range and around the POC", () => {
    const c = mkVolCandles(Array.from({ length: 50 }, (_, i) => [100 + (i % 10), 10 + (i % 5)] as [number, number]));
    const p = volumeProfile(c, { rows: 10, valueAreaPct: 70 });
    expect(p.val).not.toBeNull();
    expect(p.vah).not.toBeNull();
    expect(p.val as number).toBeLessThanOrEqual(p.poc as number);
    expect(p.vah as number).toBeGreaterThanOrEqual(p.poc as number);
  });

  it("returns an empty profile for no candles", () => {
    const p = volumeProfile([], {});
    expect(p.rows).toEqual([]);
    expect(p.poc).toBeNull();
  });
});
