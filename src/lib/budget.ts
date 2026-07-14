/** Budget engine — pure math over a plain txns array + budget list.
 * DB access lives in the caller (route or edge fn). */

export interface BudgetRow {
  id?: string;
  category: string;
  monthly_limit: number;
  rollover?: boolean;
  active?: boolean;
}

export interface BudgetTxn {
  txn_date: string;
  amount: number | string;
  txn_type: "debit" | "credit";
  category?: string | null;
}

export interface BudgetStatus {
  category: string;
  limit: number;
  spent: number;
  remaining: number;
  pct: number;              // 0-100+
  state: "ok" | "warn" | "over";
}

export function monthKey(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function computeBudgetStatus(
  budgets: BudgetRow[],
  txns: BudgetTxn[],
  opts: { period?: string } = {},
): BudgetStatus[] {
  const period = opts.period ?? monthKey(new Date());
  const spendByCat = new Map<string, number>();
  for (const t of txns) {
    if (t.txn_type !== "debit") continue;
    if (monthKey(t.txn_date) !== period) continue;
    const cat = (t.category ?? "Uncategorized").trim();
    if (!cat) continue;
    spendByCat.set(cat, (spendByCat.get(cat) ?? 0) + (Number(t.amount) || 0));
  }
  return budgets
    .filter((b) => b.active !== false)
    .map((b) => {
      const spent = spendByCat.get(b.category) ?? 0;
      const pct = b.monthly_limit > 0 ? (spent / b.monthly_limit) * 100 : 0;
      const state: BudgetStatus["state"] = pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok";
      return {
        category: b.category,
        limit: b.monthly_limit,
        spent: Math.round(spent * 100) / 100,
        remaining: Math.round((b.monthly_limit - spent) * 100) / 100,
        pct: Math.round(pct * 10) / 10,
        state,
      };
    })
    .sort((a, b) => b.pct - a.pct);
}

/** Returns true when spend has JUST crossed 80% or 100%
 * (given the previous status). Used by finance-detect. */
export function crossedThreshold(prev: BudgetStatus, next: BudgetStatus): "80" | "100" | null {
  if (prev.pct < 100 && next.pct >= 100) return "100";
  if (prev.pct < 80 && next.pct >= 80) return "80";
  return null;
}