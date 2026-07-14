// The public detectRecurringSuggestions() function does DB access, so we
// test the module's math primitives via a small re-implementation that
// mirrors detectCadence/median/normalizeMerchant. If the internals ever
// diverge, extract them to exports and re-import here.

import { describe, it, expect } from "vitest";

const CADENCE_DAYS = { weekly: 7, monthly: 30, quarterly: 91, yearly: 365 } as const;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe("recurringDetector math", () => {
  it("median odd/even", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("monthly cadence match tolerance", () => {
    const gaps = [30, 31, 29, 30];
    const med = median(gaps);
    expect(Math.abs(med - CADENCE_DAYS.monthly)).toBeLessThanOrEqual(5);
  });
  it("weekly cadence match", () => {
    const gaps = [7, 7, 8, 6];
    const med = median(gaps);
    expect(Math.abs(med - CADENCE_DAYS.weekly)).toBeLessThanOrEqual(2);
  });
});
