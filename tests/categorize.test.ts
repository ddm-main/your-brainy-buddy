import { describe, it, expect } from "vitest";
import { applyRules, type CategoryRule } from "../src/lib/categorize";

describe("categorize.applyRules", () => {
  const rules: CategoryRule[] = [
    { match_type: "merchant", pattern: "Amazon", category: "Shopping", priority: 100 },
    { match_type: "contains", pattern: "swiggy", category: "Food", priority: 100 },
    { match_type: "regex", pattern: "^uber\\b", category: "Transport", priority: 100 },
    { match_type: "merchant", pattern: "amazon prime", category: "Subscriptions", priority: 300 },
  ];
  it("returns null when nothing matches", () => {
    expect(applyRules({ merchant: "Nothing here" }, rules)).toBeNull();
  });
  it("merchant normalization matches", () => {
    expect(applyRules({ merchant: "AMAZON PVT LTD" }, rules)).toBe("Shopping");
  });
  it("contains matches", () => {
    expect(applyRules({ description: "UPI/Swiggy/foo" }, rules)).toBe("Food");
  });
  it("regex matches", () => {
    expect(applyRules({ merchant: "Uber India" }, rules)).toBe("Transport");
  });
  it("priority order wins", () => {
    expect(applyRules({ merchant: "Amazon Prime" }, rules)).toBe("Subscriptions");
  });
  it("skips invalid regex quietly", () => {
    expect(applyRules({ merchant: "x" }, [{ match_type: "regex", pattern: "[", category: "x" }])).toBeNull();
  });
});
