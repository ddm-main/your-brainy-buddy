import { describe, it, expect } from "vitest";
import { detectSalary } from "../src/lib/detectors/salary";
import { detectInvestments } from "../src/lib/detectors/investment";
import { detectDuplicates } from "../src/lib/detectors/duplicate";
import { detectAnomalies } from "../src/lib/detectors/anomaly";

function mkCredit(id: string, date: string, amount: number, merchant = "ACME Payroll"): any {
  return { id, txn_date: date, amount, txn_type: "credit", merchant };
}
function mkDebit(id: string, date: string, amount: number, merchant: string, category = "Food"): any {
  return { id, txn_date: date, amount, txn_type: "debit", merchant, category };
}

describe("detectors", () => {
  it("salary: flags stable monthly credits", () => {
    const hits = detectSalary([
      mkCredit("1", "2026-05-01", 100000),
      mkCredit("2", "2026-06-02", 100000),
      mkCredit("3", "2026-07-01", 100000),
    ]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].occurrences).toBe(3);
  });
  it("salary: ignores single credit", () => {
    expect(detectSalary([mkCredit("1", "2026-05-01", 100000)])).toHaveLength(0);
  });
  it("investments: SIP keyword detection", () => {
    const hits = detectInvestments([
      mkDebit("1", "2026-05-05", 5000, "Zerodha SIP"),
      mkDebit("2", "2026-06-05", 5000, "Zerodha SIP"),
    ]);
    expect(hits.length).toBeGreaterThan(0);
  });
  it("duplicates: cross-source", () => {
    const hits = detectDuplicates([
      { ...mkDebit("a", "2026-07-01", 500, "Swiggy"), source: "email" },
      { ...mkDebit("b", "2026-07-02", 500, "Swiggy"), source: "statement" },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].amount).toBe(500);
  });
  it("anomalies: stddev outlier", () => {
    const baseline = Array.from({ length: 20 }, (_, i) => mkDebit(String(i + 1), `2026-07-${String((i % 27) + 1).padStart(2, "0")}`, 100 + (i % 5) * 5, "S"));
    const outlier = mkDebit("99", "2026-07-28", 100000, "BigCharge");
    const hits = detectAnomalies([...baseline, outlier]);
    expect(hits.some((h) => h.txnId === "99" && h.reason === "stddev")).toBe(true);
  });
  it("anomalies: foreign flag", () => {
    const hits = detectAnomalies([
      mkDebit("1", "2026-07-01", 100, "usd purchase"),
    ]);
    expect(hits.some((h) => h.reason === "foreign")).toBe(true);
  });
});
