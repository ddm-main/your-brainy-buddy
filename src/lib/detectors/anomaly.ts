import type { DetectorTxn } from "./salary";

export interface AnomalyHit {
  txnId: string;
  merchant: string;
  amount: number;
  category: string;
  reason: "stddev" | "odd_hour" | "foreign";
  detail: string;
}

/** Per-category stddev outliers (>3σ) + foreign-currency hints. */
export function detectAnomalies(txns: DetectorTxn[]): AnomalyHit[] {
  const debits = txns.filter((t) => t.txn_type === "debit");
  const byCat = new Map<string, DetectorTxn[]>();
  for (const t of debits) {
    const c = (t.category ?? "Uncategorized").trim();
    const bucket = byCat.get(c) ?? [];
    bucket.push(t);
    byCat.set(c, bucket);
  }
  const out: AnomalyHit[] = [];
  for (const [cat, arr] of byCat) {
    if (arr.length < 5) continue;
    const amts = arr.map((t) => Number(t.amount));
    const mean = amts.reduce((s, a) => s + a, 0) / amts.length;
    const variance = amts.reduce((s, a) => s + (a - mean) ** 2, 0) / amts.length;
    const sd = Math.sqrt(variance);
    for (const t of arr) {
      const a = Number(t.amount);
      if (sd > 0 && a > mean + 3 * sd && a > mean * 2) {
        out.push({
          txnId: t.id,
          merchant: t.merchant ?? "—",
          amount: a,
          category: cat,
          reason: "stddev",
          detail: `${Math.round((a / mean) * 10) / 10}× category average`,
        });
      }
    }
  }
  for (const t of debits) {
    const hay = `${t.merchant ?? ""} ${t.description ?? ""}`;
    if (/\b(usd|eur|gbp|aed|sgd|foreign|fx)\b/i.test(hay)) {
      out.push({
        txnId: t.id,
        merchant: t.merchant ?? "—",
        amount: Number(t.amount),
        category: t.category ?? "Uncategorized",
        reason: "foreign",
        detail: "possible foreign-currency charge",
      });
    }
  }
  return out;
}