import { describe, it, expect } from "vitest";
import {
  classifyVolumeSeries,
  decumulateVolumes,
  decumulateBars,
  repairVolumeSeries,
  looksCumulative,
  sessionOpenSecFor,
} from "../supabase/functions/_shared/market/volume.ts";

// 2026-08-03 09:15 IST session open, in epoch seconds.
const OPEN = sessionOpenSecFor(Math.floor(Date.UTC(2026, 7, 3, 6, 0, 0) / 1000));
const bar = (i: number, volume: number) => ({ time: OPEN + i * 60, volume });

// Real stored NILKAMAL 1m values (source kotak_quote, 2026-08-03 12:00 IST on),
// which are the running day total rather than per-bar volume.
const COUNTER = [34_811, 34_975, 35_350, 35_840, 36_373, 36_626, 36_956, 37_157, 38_064];
const COUNTER_DELTAS = [164, 375, 490, 533, 253, 330, 201, 907];

describe("repairVolumeSeries", () => {
  it("repairs a day-cumulative counter into per-bar volume", () => {
    const { volumes, repairedRuns } = repairVolumeSeries(COUNTER);
    expect(repairedRuns).toBe(1);
    expect(volumes.slice(1)).toEqual(COUNTER_DELTAS);
    // first bar capped at the typical step, never the whole pre-history
    expect(volumes[0]).toBeLessThanOrEqual(400);
  });

  it("leaves a genuine per-bar series alone", () => {
    const vols = [8000, 2400, 3100, 900, 5200, 1400, 2600, 700, 3300, 1200];
    expect(repairVolumeSeries(vols).repairedRuns).toBe(0);
  });

  it("leaves a slowly rising per-bar series alone", () => {
    // values are the same order of magnitude as the steps between them
    const vols = [1000, 1200, 1400, 1500, 1800, 2000, 2400];
    expect(repairVolumeSeries(vols).repairedRuns).toBe(0);
  });

  it("repairs only the cumulative tail of a mixed session (the real NILKAMAL shape)", () => {
    // honest per-bar prints near the open, then the writer loses its baseline
    // and starts storing the running day total
    const perBar = [989, 3716, 1173, 921, 2660, 601];
    const { volumes, repairedRuns } = repairVolumeSeries([...perBar, ...COUNTER]);
    expect(repairedRuns).toBe(1);
    expect(volumes.slice(0, 6)).toEqual(perBar);
    // the counter's first value is not charged to the last honest bar
    expect(volumes[6]).toBeLessThanOrEqual(400);
    expect(volumes.slice(7)).toEqual(COUNTER_DELTAS);
  });

  it("ignores runs shorter than the minimum", () => {
    expect(repairVolumeSeries([1000, 50_000, 50_400, 50_900]).repairedRuns).toBe(0);
  });
});

describe("decumulateVolumes", () => {
  it("converts a running total into per-bar deltas", () => {
    // first bar capped at the median delta (500), the rest are true deltas
    expect(decumulateVolumes([1000, 1500, 1800, 2600])).toEqual([500, 500, 300, 800]);
  });

  it("restarts the baseline when the counter drops", () => {
    expect(decumulateVolumes([1000, 1400, 300, 900, 1500]).slice(1)).toEqual([400, 300, 600, 600]);
  });
});

describe("decumulateBars", () => {
  it("kills the staircase and keeps the day total sane", () => {
    const { bars, repairedSessions } = decumulateBars(COUNTER.map((v, i) => bar(i, v)));
    expect(repairedSessions).toBe(1);
    const total = bars.reduce((s, b) => s + b.volume, 0);
    // ~= the counter's own growth over the window, not 9x the day total
    expect(total).toBeLessThan(4000);
    expect(total).toBeGreaterThan(3000);
    expect(bars.every((b) => b.volume >= 0)).toBe(true);
    expect(looksCumulative(bars)).toBe(false);
  });

  it("does not touch an honest per-bar series", () => {
    const vols = [8000, 2400, 3100, 900, 5200, 1400, 2600, 700, 3300];
    const { bars, repairedSessions } = decumulateBars(vols.map((v, i) => bar(i, v)));
    expect(repairedSessions).toBe(0);
    expect(bars.map((b) => b.volume)).toEqual(vols);
  });

  it("treats each session independently", () => {
    const day1 = COUNTER.map((v, i) => bar(i, v));
    const day2 = COUNTER.map((v, i) => ({ time: OPEN + 86_400 + i * 60, volume: v * 2 }));
    const { bars, repairedSessions } = decumulateBars([...day1, ...day2]);
    expect(repairedSessions).toBe(2);
    expect(bars).toHaveLength(18);
    expect(bars[0].volume).toBeLessThanOrEqual(400);
    expect(bars[9].volume).toBeLessThanOrEqual(800);
  });

  it("keeps 1m -> 5m bucket sums honest after repair", () => {
    const cum = Array.from({ length: 10 }, (_, i) => 10_000 + (i + 1) * 400);
    const { bars } = decumulateBars(cum.map((v, i) => bar(i, v)));
    const bucketA = bars.slice(0, 5).reduce((s, b) => s + b.volume, 0);
    const bucketB = bars.slice(5).reduce((s, b) => s + b.volume, 0);
    // each 5m bucket ~= 5 * 400, not 5 * a cumulative figure
    expect(bucketA).toBeLessThan(3000);
    expect(bucketB).toBeLessThan(3000);
  });
});

describe("classifyVolumeSeries", () => {
  it("agrees with the repair pass", () => {
    expect(classifyVolumeSeries(COUNTER).cumulative).toBe(true);
    expect(classifyVolumeSeries([800, 240, 310, 90, 520, 140, 260, 70, 330]).cumulative).toBe(false);
  });
});
