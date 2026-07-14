import { describe, it, expect } from "vitest";
import { calcNetWorth, calcCreditUtilization, calcHealthScore, generateAmortizationSchedule } from "../src/lib/financeMetrics";

describe("financeMetrics", () => {
  it("netWorth: assets - liabilities + tracked savings", () => {
    const r = calcNetWorth({
      accounts: [{ current_balance: 100 }, { current_balance: 50 }],
      cardDebts: [{ total_due: 30 }],
      loans: [{ outstanding_amount: 20 }],
      goals: [{ current_amount: 25 }],
    });
    expect(r.assets).toBe(150);
    expect(r.liabilities).toBe(50);
    expect(r.trackedSavings).toBe(25);
    expect(r.netWorth).toBe(125);
  });
  it("utilization aggregates cards", () => {
    const u = calcCreditUtilization([
      { cardId: "1", cardName: "A", limit: 1000, totalDue: 300 },
      { cardId: "2", cardName: "B", limit: 2000, totalDue: 500 },
      { cardId: "3", cardName: "C", limit: null, totalDue: 100 },
    ]);
    expect(u.aggregatePct).toBeCloseTo(((300 + 500) / 3000) * 100, 1);
    expect(u.perCard.find((c) => c.cardId === "3")?.utilizationPct).toBeNull();
  });
  it("healthScore stays neutral without data", () => {
    const h = calcHealthScore({
      income: 0, spend: 0, utilizationPct: null, openAlerts: 0,
      trackedObligations: 0, assets: 0, liabilities: 0, hasBalanceData: false,
    });
    expect(h.score).toBeGreaterThan(0);
    expect(h.score).toBeLessThanOrEqual(100);
  });
  it("healthScore rewards clean profile", () => {
    const h = calcHealthScore({
      income: 100000, spend: 50000, utilizationPct: 5, openAlerts: 0,
      trackedObligations: 3, assets: 500000, liabilities: 50000, hasBalanceData: true,
    });
    expect(h.score).toBeGreaterThan(80);
  });
  it("amortization sums to principal", () => {
    const rows = generateAmortizationSchedule(120000, 12, 12)!;
    expect(rows).toHaveLength(12);
    const principalSum = rows.reduce((s, r) => s + r.principal, 0);
    expect(Math.round(principalSum)).toBe(120000);
    expect(rows[rows.length - 1].balance).toBe(0);
  });
  it("amortization null on bad input", () => {
    expect(generateAmortizationSchedule(0, 10, 12)).toBeNull();
  });
});
