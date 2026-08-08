import { describe, expect, it } from "vitest";
import {
  V4_BUCKETS,
  BUCKET_MIN_COVERAGE,
  V4_FULL_RENORM_COVERAGE,
  buildBucketRows,
} from "@/lib/market/scoreExplain";
import {
  V4_WEIGHTS,
  BUCKET_MIN_COVERAGE as SCORER_BUCKET_MIN_COVERAGE,
  V4_FULL_RENORM_COVERAGE as SCORER_FULL_RENORM_COVERAGE,
} from "../supabase/functions/_shared/market/scoring.ts";

// The score the user reads and the explanation shown next to it come from two
// separate tables — the scorer's (edge function) and the UI's. Nothing at
// runtime cross-checks them, so a weight tweak on one side silently produces
// an explanation that does not add up to the score. These tests are that check.
describe("v4 bucket weights", () => {
  it("has the same buckets on both sides", () => {
    expect(V4_BUCKETS.map((b) => b.key).sort()).toEqual(
      Object.keys(V4_WEIGHTS).sort(),
    );
  });

  it("uses the same weight for every bucket", () => {
    for (const b of V4_BUCKETS) {
      expect(b.weight, `bucket ${b.key}`).toBe(
        V4_WEIGHTS[b.key as keyof typeof V4_WEIGHTS],
      );
    }
  });

  it("sums to 100", () => {
    expect(V4_BUCKETS.reduce((s, b) => s + b.weight, 0)).toBe(100);
    expect(Object.values(V4_WEIGHTS).reduce((s, w) => s + w, 0)).toBe(100);
  });

  it("agrees on the per-bucket coverage floor", () => {
    expect(BUCKET_MIN_COVERAGE).toBe(SCORER_BUCKET_MIN_COVERAGE);
  });

  it("gives every bucket sub-factor weights summing to 1", () => {
    for (const b of V4_BUCKETS) {
      const sum = b.factors.reduce((s, f) => s + f.w, 0);
      expect(Math.abs(sum - 1) < 1e-9, `bucket ${b.key} sub-weights = ${sum}`)
        .toBe(true);
    }
  });

  it("agrees on the renormalisation cap", () => {
    expect(V4_FULL_RENORM_COVERAGE).toBe(SCORER_FULL_RENORM_COVERAGE);
  });
});

// Dropping a bucket must never make a stock look better. Before the cap, the
// missing weight was redistributed in full, so a name scored on 60% of the
// model was multiplied by 1.67x and could out-rank a fully covered one.
describe("v4 coverage cannot inflate the ceiling", () => {
  const full = Object.fromEntries(V4_BUCKETS.map((b) => [b.key, 1]));

  it("never scales the surviving buckets past the cap", () => {
    const cov = { ...full, strength: 0, sentiment: 0, patterns: 0 };
    const rows = buildBucketRows({}, cov);
    const ceiling = rows.reduce((s, r) => s + r.ceiling, 0);
    expect(ceiling).toBeLessThanOrEqual(100.05);
    // 78% of the weight survives, so the ceiling must be visibly under 100
    // rather than scaled back up to it.
    expect(ceiling).toBeLessThan(95);
  });

  it("still reaches a 100-point ceiling at full coverage", () => {
    const rows = buildBucketRows({}, full);
    const ceiling = rows.reduce((s, r) => s + r.ceiling, 0);
    expect(Math.abs(ceiling - 100)).toBeLessThan(0.2);
  });

  it("gives a dropped bucket no ceiling and no points", () => {
    const rows = buildBucketRows({ strength: 9 }, { ...full, strength: 0.2 });
    const strength = rows.find((r) => r.key === "strength")!;
    expect(strength.present).toBe(false);
    expect(strength.ceiling).toBe(0);
  });
});
