import { describe, expect, it } from "vitest";
import { deriveBreakoutStage, STAGE_ORDER } from "../src/lib/market/breakoutStage";
import { EXTEND_PCT, FAIL_PCT, COOL_DAYS, MAX_TRACK_DAYS } from "../src/lib/market/scoreBands";

const snap = (o: Record<string, unknown>) => o as any;

describe("deriveBreakoutStage", () => {
  it("reports NO DATA when there is no price", () => {
    expect(deriveBreakoutStage(snap({ close: null, atr14: 5, ema20: 100 })).stage).toBe("NO DATA");
    expect(deriveBreakoutStage(snap({ close: 0, atr14: 5, ema20: 100 })).stage).toBe("NO DATA");
  });

  it("does not manufacture EXTENDED from a zero price", () => {
    // close 0 with ema20 100 / atr 5 is -20 ATRs; the old `?? 0` fallback in the
    // caller made this read as a confident stage instead of missing data.
    expect(deriveBreakoutStage(snap({ close: null, ema20: 100, atr14: 5 })).stage).not.toBe("EXTENDED");
  });

  it("reports NO DATA when no coil input was measured", () => {
    const r = deriveBreakoutStage(snap({
      close: 100, ema20: 99, atr14: 2,
      bbSqueeze: null, atrContracting: null, baseTightness: null,
    }));
    expect(r.stage).toBe("NO DATA");
  });

  it("reports NO SETUP when inputs were measured and nothing is forming", () => {
    const r = deriveBreakoutStage(snap({
      close: 100, ema20: 99, atr14: 2,
      bbSqueeze: false, atrContracting: false, baseTightness: 0.2,
    }));
    expect(r.stage).toBe("NO SETUP");
  });

  it("uses rollingHigh55 as a trigger level when it is the only one", () => {
    const r = deriveBreakoutStage(snap({
      close: 105, ema20: 100, atr14: 3,
      rollingHigh55: 102, breakoutFreshnessDays: 1,
    }));
    expect(r.stage).toBe("TRIGGERED");
  });

  it("checks FAILED before anything else", () => {
    expect(deriveBreakoutStage(snap({
      close: 90, ema20: 100, atr14: 2, breakoutStateKind: "failed", breakoutLevelCleared: 100,
    })).stage).toBe("FAILED");
  });

  it("orders stages along the lifecycle, not alphabetically", () => {
    expect(STAGE_ORDER.COILED).toBeLessThan(STAGE_ORDER.ARMED);
    expect(STAGE_ORDER.ARMED).toBeLessThan(STAGE_ORDER.TRIGGERED);
    expect(STAGE_ORDER.TRIGGERED).toBeLessThan(STAGE_ORDER.EXTENDED);
  });
});

describe("lifecycle constants mirror the state machine", () => {
  it("matches nextEpisodeStatus in the edge scorer", async () => {
    const src = await import("node:fs/promises")
      .then((fs) => fs.readFile("supabase/functions/_shared/market/scoring.ts", "utf8"));
    expect(src).toContain(`EXTEND_PCT = ${EXTEND_PCT}`);
    expect(src).toContain(`FAIL_PCT = ${FAIL_PCT}`);
    expect(src).toContain(`COOL_DAYS = ${COOL_DAYS}`);
    expect(src).toContain(`MAX_TRACK_DAYS = ${MAX_TRACK_DAYS}`);
  });
});
