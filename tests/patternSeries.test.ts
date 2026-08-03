import { describe, expect, it } from "vitest";
import {
  candleMarksAt, detectBearPatterns, detectPatternSeries, toWeeklyCandles,
} from "../supabase/functions/_shared/market/pattern-series.ts";

type C = { time: number; open: number; high: number; low: number; close: number; volume: number };
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): C =>
  // 1699833600 = Mon 2023-11-13 00:00 UTC, so index 0 starts a fresh week.
  ({ time: 1699833600 + i * 86400, open: o, high: h, low: l, close: c, volume: v });

// Filler bars so the ATR seed exists and short-trend context is defined.
function trend(from: number, to: number, n: number, startIdx = 0): C[] {
  const step = (to - from) / n;
  return Array.from({ length: n }, (_, i) => {
    const o = from + step * i;
    const c = o + step;
    return bar(startIdx + i, o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c);
  });
}

const keysAt = (cs: C[], i: number) => candleMarksAt(cs, i, 1).map((m) => m.key);

describe("candleMarksAt", () => {
  it("flags a bullish engulfing after a red bar", () => {
    const cs = [...trend(100, 90, 6), bar(6, 92, 92.5, 89, 89.5), bar(7, 89, 93.5, 88.8, 93.4)];
    expect(keysAt(cs, cs.length - 1)).toContain("bullish_engulfing");
  });

  it("flags a bearish engulfing after a green bar", () => {
    const cs = [...trend(90, 100, 6), bar(6, 100, 103, 99.8, 102.8), bar(7, 103, 103.2, 99, 99.2)];
    expect(keysAt(cs, cs.length - 1)).toContain("bearish_engulfing");
  });

  it("distinguishes hammer (downtrend) from hanging man (uptrend)", () => {
    const down = [...trend(110, 100, 6), bar(6, 100, 100.4, 96, 100.2)];
    expect(keysAt(down, down.length - 1)).toContain("hammer");
    const up = [...trend(100, 110, 6), bar(6, 110, 110.4, 106, 110.2)];
    expect(keysAt(up, up.length - 1)).toContain("hanging_man");
  });

  it("flags three white soldiers only on three decisive rising closes", () => {
    const cs = [...trend(90, 95, 5), bar(5, 95, 97.1, 94.9, 97), bar(6, 97, 99.1, 96.9, 99), bar(7, 99, 101.1, 98.9, 101)];
    expect(keysAt(cs, cs.length - 1)).toContain("three_white_soldiers");
  });

  it("flags a morning star reversal", () => {
    const cs = [...trend(110, 100, 5), bar(5, 100, 100.2, 94, 94.2), bar(6, 94, 94.6, 93.4, 94.1), bar(7, 94.4, 98.5, 94.2, 98.2)];
    expect(keysAt(cs, cs.length - 1)).toContain("morning_star");
  });

  it("does not call a flat, rangeless bar a doji", () => {
    const cs = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100)];
    expect(keysAt(cs, 1)).toHaveLength(0);
  });
});

describe("detectBearPatterns", () => {
  it("detects a double top when price falls back through the trough", () => {
    const cs = [
      ...trend(100, 130, 20),
      ...trend(130, 112, 15, 20),
      ...trend(112, 129, 15, 35),
      ...trend(129, 110, 15, 50),
    ];
    expect(detectBearPatterns(cs).double_top).toBe(true);
  });

  it("stays quiet on a clean uptrend", () => {
    const cs = trend(100, 200, 90);
    const f = detectBearPatterns(cs);
    expect(f.double_top || f.head_shoulders || f.descending_triangle).toBe(false);
  });
});

describe("detectPatternSeries", () => {
  it("returns marks across the whole series, not just the last bar", () => {
    const cs = [
      ...trend(100, 90, 6),
      bar(6, 92, 92.5, 89, 89.5), bar(7, 89, 93.5, 88.8, 93.4),
      ...trend(94, 104, 10, 8),
      bar(18, 104, 107, 103.8, 106.8), bar(19, 107, 107.2, 103, 103.2),
    ];
    const { marks } = detectPatternSeries(cs);
    const idx = marks.map((m) => m.index);
    expect(Math.min(...idx)).toBeLessThan(10);
    expect(Math.max(...idx)).toBeGreaterThan(15);
  });

  it("collapses a persistent structure into one shape", () => {
    const cs = [
      ...trend(100, 130, 20),
      ...trend(130, 112, 15, 20),
      ...trend(112, 129, 15, 35),
      ...trend(129, 108, 20, 50),
    ];
    const { shapes } = detectPatternSeries(cs);
    const tops = shapes.filter((s) => s.key === "double_top");
    expect(tops.length).toBeLessThanOrEqual(2);
    for (const t of tops) expect(t.endIndex).toBeGreaterThan(t.startIndex);
  });

  it("does not duplicate a rectangle as a horizontal channel", () => {
    const cs = Array.from({ length: 80 }, (_, i) => {
      const mid = 100 + Math.sin(i * Math.PI / 3) * 3;
      return bar(i, mid - 0.2, mid + 1, mid - 1, mid + 0.2, 1000 + (i % 4) * 20);
    });
    const { shapes } = detectPatternSeries(cs, { maxShapes: 200 });
    expect(shapes.some((s) => s.key === "rectangle")).toBe(true);
    expect(shapes.some((s) => s.key === "horizontal_channel")).toBe(false);
  });

  it("caps persistent local structures instead of drawing hundred-bar runs", () => {
    const cs = Array.from({ length: 180 }, (_, i) => {
      const mid = 100 + Math.sin(i * Math.PI / 3) * 3;
      return bar(i, mid - 0.2, mid + 1, mid - 1, mid + 0.2, 1000);
    });
    const rectangles = detectPatternSeries(cs, { maxShapes: 200 }).shapes.filter((s) => s.key === "rectangle");
    expect(rectangles.length).toBeGreaterThan(0);
    expect(Math.max(...rectangles.map((s) => s.endIndex - s.startIndex + 1))).toBeLessThanOrEqual(75);
  });

  it("does not label ordinary range flow as Wyckoff without a sweep event", () => {
    const cs = Array.from({ length: 70 }, (_, i) => {
      const mid = 100 + Math.sin(i * Math.PI / 4) * 2;
      return bar(i, mid - 0.2, mid + 0.8, mid - 0.8, mid + 0.2, 1000 + i * 10);
    });
    const keys = detectPatternSeries(cs, { maxShapes: 200 }).shapes.map((s) => s.key);
    expect(keys).not.toContain("wyckoff_accumulation");
    expect(keys).not.toContain("wyckoff_distribution");
  });
});

describe("toWeeklyCandles", () => {
  it("aggregates OHLCV into weekly buckets", () => {
    const cs = Array.from({ length: 14 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i, 10));
    const wk = toWeeklyCandles(cs);
    expect(wk.length).toBe(2);
    expect(wk[0].open).toBe(cs[0].open);
    expect(wk[0].close).toBe(cs[6].close);
    expect(wk[0].high).toBe(Math.max(...cs.slice(0, 7).map((c) => c.high)));
    expect(wk[0].volume).toBe(70);
  });
});

describe("mark windows", () => {
  it("gives multi-bar patterns a multi-bar window and a specific rule text", () => {
    const cs = [...trend(110, 100, 5), bar(5, 100, 100.2, 94, 94.2), bar(6, 94, 94.6, 93.4, 94.1), bar(7, 94.4, 98.5, 94.2, 98.2)];
    const star = candleMarksAt(cs, cs.length - 1, 1).find((m) => m.key === "morning_star")!;
    expect(star.endIndex - star.startIndex + 1).toBe(3);
    expect(star.formula).toMatch(/midpoint/);
  });

  it("keeps single-bar patterns one bar wide", () => {
    const down = [...trend(110, 100, 6), bar(6, 100, 100.4, 96, 100.2)];
    const hammer = candleMarksAt(down, down.length - 1, 1).find((m) => m.key === "hammer")!;
    expect(hammer.startIndex).toBe(hammer.endIndex);
  });
});
