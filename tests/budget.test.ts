import { describe, it, expect } from "vitest";
import { computeBudgetStatus, crossedThreshold, monthKey } from "../src/lib/budget";

const M = monthKey(new Date());
const today = new Date().toISOString().slice(0, 10);

describe("budget", () => {
  it("ignores credits and other months", () => {
    const rows = computeBudgetStatus(
      [{ category: "Food", monthly_limit: 1000 }],
      [
        { txn_date: today, amount: 600, txn_type: "debit", category: "Food" },
        { txn_date: today, amount: 500, txn_type: "credit", category: "Food" },
        { txn_date: "2000-01-01", amount: 500, txn_type: "debit", category: "Food" },
      ],
    );
    expect(rows[0].spent).toBe(600);
    expect(rows[0].state).toBe("ok");
  });
  it("crosses 80% threshold at 80%", () => {
    const rows = computeBudgetStatus(
      [{ category: "Food", monthly_limit: 1000 }],
      [{ txn_date: today, amount: 850, txn_type: "debit", category: "Food" }],
    );
    expect(rows[0].pct).toBeGreaterThanOrEqual(80);
    expect(rows[0].state).toBe("warn");
  });
  it("marks over when spend >= limit", () => {
    const rows = computeBudgetStatus(
      [{ category: "Food", monthly_limit: 1000 }],
      [{ txn_date: today, amount: 1500, txn_type: "debit", category: "Food" }],
    );
    expect(rows[0].state).toBe("over");
    expect(rows[0].pct).toBeGreaterThanOrEqual(100);
  });
  it("crossedThreshold reports jumps", () => {
    const prev = { category: "x", limit: 100, spent: 70, remaining: 30, pct: 70, state: "ok" as const };
    const next = { category: "x", limit: 100, spent: 85, remaining: 15, pct: 85, state: "warn" as const };
    expect(crossedThreshold(prev, next)).toBe("80");
    const over = { category: "x", limit: 100, spent: 110, remaining: -10, pct: 110, state: "over" as const };
    expect(crossedThreshold(next, over)).toBe("100");
    expect(crossedThreshold(prev, prev)).toBeNull();
  });
  it("skips inactive budgets", () => {
    const rows = computeBudgetStatus(
      [{ category: "Food", monthly_limit: 1000, active: false }],
      [{ txn_date: today, amount: 500, txn_type: "debit", category: "Food" }],
    );
    expect(rows).toHaveLength(0);
  });
  it("monthKey matches current period", () => {
    expect(monthKey(new Date())).toBe(M);
  });
});
