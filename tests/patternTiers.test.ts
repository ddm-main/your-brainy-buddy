import { describe, expect, it } from "vitest";
import { detailFromParam, detailToParam, tierAllows, tierOf } from "../src/lib/market/patternLabels";

describe("pattern significance tiers", () => {
  it("grades decisive reversals as key and filler as noise", () => {
    expect(tierOf("bearish_engulfing")).toBe("key");
    expect(tierOf("head_shoulders")).toBe("key");
    expect(tierOf("inside_bar")).toBe("noise");
    expect(tierOf("nr7")).toBe("noise");
    expect(tierOf("doji")).toBe("noise");
    expect(tierOf("piercing_line")).toBe("key");
    expect(tierOf("volume_dryup")).toBe("context");
  });

  it("filters by detail level", () => {
    expect(tierAllows("hammer", "key")).toBe(true);
    expect(tierAllows("volume_dryup", "key")).toBe(false);
    expect(tierAllows("volume_dryup", "context")).toBe(true);
    expect(tierAllows("nr4", "context")).toBe(false);
    expect(tierAllows("nr4", "all")).toBe(true);
  });

  it("round-trips the numeric study param", () => {
    for (const d of ["key", "context", "all"] as const) {
      expect(detailFromParam(detailToParam(d))).toBe(d);
    }
    expect(detailFromParam(undefined)).toBe("key");
    expect(detailFromParam(99)).toBe("all");
  });
});
