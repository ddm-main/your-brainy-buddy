import { describe, expect, it } from "vitest";
import {
  reconcileSameDay, resolveEntryPrice, nextScoreTrend,
} from "../supabase/functions/_shared/market/breakoutEpisode.ts";

const QUALIFY = 70;
const D1 = "2026-07-30";
const D2 = "2026-07-31";

describe("reconcileSameDay", () => {
  it("advances counters on a new session", () => {
    const r = reconcileSameDay(
      { first_detected_date: D1, last_evaluated_date: D1, days_tracked: 3, below_threshold_days: 1, last_score: 62 },
      D2, QUALIFY,
    );
    expect(r).toEqual({ alreadyToday: false, openedToday: false, prevDays: 3, prevBelow: 1 });
  });

  it("reverses today's increments on a same-session re-run", () => {
    const r = reconcileSameDay(
      { first_detected_date: D1, last_evaluated_date: D2, days_tracked: 4, below_threshold_days: 2, last_score: 62 },
      D2, QUALIFY,
    );
    expect(r.alreadyToday).toBe(true);
    expect(r.prevDays).toBe(3);
    expect(r.prevBelow).toBe(1);
  });

  it("does not reverse the below-threshold counter when today qualified", () => {
    const r = reconcileSameDay(
      { first_detected_date: D1, last_evaluated_date: D2, days_tracked: 4, below_threshold_days: 2, last_score: 81 },
      D2, QUALIFY,
    );
    expect(r.prevBelow).toBe(2);
  });

  it("never goes negative on missing counters", () => {
    const r = reconcileSameDay(
      { first_detected_date: D2, last_evaluated_date: D2, days_tracked: 0, below_threshold_days: 0, last_score: 10 },
      D2, QUALIFY,
    );
    expect(r.openedToday).toBe(true);
    expect(r.prevDays).toBe(0);
    expect(r.prevBelow).toBe(0);
  });
});

describe("resolveEntryPrice", () => {
  it("re-reads the close while still inside the opening session", () => {
    expect(resolveEntryPrice({ first_detected_date: D2, entry_close: 100 }, 104, true)).toBe(104);
  });
  it("is immutable from the next session on", () => {
    expect(resolveEntryPrice({ first_detected_date: D1, entry_close: 100 }, 104, false)).toBe(100);
  });
  it("falls back to the close when no entry was stored", () => {
    expect(resolveEntryPrice({ first_detected_date: D1, entry_close: null }, 104, false)).toBe(104);
  });
});

describe("nextScoreTrend", () => {
  it("appends on a new session", () => {
    expect(nextScoreTrend([70, 72], 75, false, 0, 30)).toEqual([70, 72, 75]);
  });
  it("corrects the last point in place on a re-run", () => {
    expect(nextScoreTrend([70, 72], 74, true, 0, 30)).toEqual([70, 74]);
  });
  it("inserts explicit gaps for skipped sessions", () => {
    expect(nextScoreTrend([70], 75, false, 2, 30)).toEqual([70, null, null, 75]);
  });
  it("respects the cap", () => {
    expect(nextScoreTrend([1, 2, 3], 4, false, 0, 3)).toEqual([2, 3, 4]);
  });
  it("handles an empty trend on a re-run", () => {
    expect(nextScoreTrend([], 66, true, 0, 30)).toEqual([66]);
  });
});
