import { describe, expect, it } from "vitest";
import { V4_BUCKETS, BUCKET_MIN_COVERAGE } from "@/lib/market/scoreExplain";
import {
  V4_WEIGHTS,
  BUCKET_MIN_COVERAGE as SCORER_BUCKET_MIN_COVERAGE,
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
});
