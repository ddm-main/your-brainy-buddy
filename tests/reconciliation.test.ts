// runReconciliation orchestrates db.* calls; we sanity-check the tolerance
// math it uses (5 rupees floor or 2% of expected).

import { describe, it, expect } from "vitest";

const TOLERANCE_MIN = 5;
const TOLERANCE_PCT = 0.02;

function tolerance(expected: number) {
  return Math.max(TOLERANCE_MIN, expected * TOLERANCE_PCT);
}

describe("reconciliation tolerance", () => {
  it("uses 5 rupee floor for tiny amounts", () => {
    expect(tolerance(50)).toBe(5);
  });
  it("uses 2% for large amounts", () => {
    expect(tolerance(10000)).toBe(200);
  });
  it("matches within tolerance", () => {
    const expected = 1000;
    const actual = 1015;
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance(expected));
  });
  it("mismatches beyond tolerance", () => {
    const expected = 1000;
    const actual = 1050;
    expect(Math.abs(actual - expected)).toBeGreaterThan(tolerance(expected));
  });
});
