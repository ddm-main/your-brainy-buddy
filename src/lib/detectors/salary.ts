import { normalizeMerchant } from "@/lib/merchant";

export interface DetectorTxn {
  id: string;
  txn_date: string;
  amount: number | string;
  txn_type: "debit" | "credit";
  merchant?: string | null;
  description?: string | null;
  category?: string | null;
  financial_account_id?: string | null;
  credit_card_id?: string | null;
}

export interface SalaryHit {
  merchant: string;
  amount: number;
  occurrences: number;
  avgDayOfMonth: number;
  lastDate: string;
  txnIds: string[];
}

/** Large recurring credits landing near the same day each month. */
export function detectSalary(txns: DetectorTxn[], opts: { minAmount?: number } = {}): SalaryHit[] {
  const min = opts.minAmount ?? 20000;
  const credits = txns
    .filter((t) => t.txn_type === "credit" && Number(t.amount) >= min)
    .sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  const groups = new Map<string, DetectorTxn[]>();
  for (const t of credits) {
    const key = normalizeMerchant(t.merchant ?? t.description) || "unknown-credit";
    const g = groups.get(key) ?? [];
    g.push(t);
    groups.set(key, g);
  }
  const out: SalaryHit[] = [];
  for (const [key, g] of groups) {
    if (g.length < 2) continue;
    const amts = g.map((t) => Number(t.amount));
    const med = [...amts].sort((a, b) => a - b)[Math.floor(amts.length / 2)];
    const stable = amts.filter((a) => Math.abs(a - med) / med <= 0.15).length / amts.length;
    if (stable < 0.6) continue;
    // day-of-month cluster
    const days = g.map((t) => new Date(t.txn_date).getUTCDate());
    const meanDay = days.reduce((s, d) => s + d, 0) / days.length;
    const spread = Math.max(...days) - Math.min(...days);
    if (spread > 6) continue; // not tight enough
    out.push({
      merchant: key,
      amount: Math.round(med),
      occurrences: g.length,
      avgDayOfMonth: Math.round(meanDay),
      lastDate: g[g.length - 1].txn_date,
      txnIds: g.map((t) => t.id),
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}