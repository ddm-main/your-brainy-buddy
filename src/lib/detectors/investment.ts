import type { DetectorTxn } from "./salary";

const INVEST_KEYWORDS = /\b(sip|mf|mutual\s*fund|zerodha|groww|indmoney|coin|kuvera|smallcase|nps|ppf|elss|nifty|sensex|equity)\b/i;

export interface InvestmentHit {
  merchant: string;
  amount: number;
  occurrences: number;
  lastDate: string;
  txnIds: string[];
}

/** SIP / mutual-fund debits — keyword match + monthly cadence hint. */
export function detectInvestments(txns: DetectorTxn[]): InvestmentHit[] {
  const debits = txns.filter((t) => t.txn_type === "debit");
  const groups = new Map<string, DetectorTxn[]>();
  for (const t of debits) {
    const hay = `${t.merchant ?? ""} ${t.description ?? ""}`;
    if (!INVEST_KEYWORDS.test(hay)) continue;
    const key = (t.merchant ?? "investment").toLowerCase().trim();
    const g = groups.get(key) ?? [];
    g.push(t);
    groups.set(key, g);
  }
  const out: InvestmentHit[] = [];
  for (const [key, g] of groups) {
    if (g.length < 1) continue;
    const amts = g.map((t) => Number(t.amount));
    const total = amts.reduce((s, a) => s + a, 0);
    out.push({
      merchant: key,
      amount: Math.round(total / amts.length),
      occurrences: g.length,
      lastDate: g[g.length - 1].txn_date,
      txnIds: g.map((t) => t.id),
    });
  }
  return out.sort((a, b) => b.amount * b.occurrences - a.amount * a.occurrences);
}