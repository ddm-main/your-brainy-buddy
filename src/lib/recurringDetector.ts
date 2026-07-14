/** Client-side recurring-charge detector. Groups recent debit transactions
 * by a normalized merchant key, then flags groups that fire on a roughly
 * fixed cadence (weekly / monthly / quarterly / yearly) with a stable
 * amount. Anything already covered by an existing subscription is filtered
 * out so the UI only shows *new* suggestions the user can one-click add.
 *
 * Deterministic, no AI — pure statistics over what's already in the DB. */

import { supabase } from "@/integrations/supabase/client";

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

export interface RecurringSuggestion {
  merchantKey: string;
  displayName: string;
  category: string | null;
  amount: number;              // median across matching txns
  cadence: Cadence;
  occurrences: number;
  lastDate: string;            // ISO yyyy-mm-dd
  nextDueDate: string;         // projected — lastDate + cadence
  financial_account_id: string | null;
  credit_card_id: string | null;
  sampleTxnIds: string[];
}

const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, monthly: 30, quarterly: 91, yearly: 365 };
const CADENCE_TOLERANCE: Record<Cadence, number> = { weekly: 2, monthly: 5, quarterly: 10, yearly: 20 };

export function normalizeMerchant(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.toLowerCase()
    .replace(/\b(pvt|ltd|inc|llc|india|payments?|autopay|subscription|txn|ref|upi|neft|imps)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

function detectCadence(gaps: number[]): Cadence | null {
  if (gaps.length < 2) return null;
  const med = median(gaps);
  const entries = Object.entries(CADENCE_DAYS) as [Cadence, number][];
  let best: Cadence | null = null;
  let bestDiff = Infinity;
  for (const [c, days] of entries) {
    const diff = Math.abs(med - days);
    if (diff < bestDiff && diff <= CADENCE_TOLERANCE[c]) { best = c; bestDiff = diff; }
  }
  if (!best) return null;
  // Also require most individual gaps to be near the same cadence.
  const tol = CADENCE_TOLERANCE[best];
  const hits = gaps.filter((g) => Math.abs(g - CADENCE_DAYS[best!]) <= tol).length;
  return hits / gaps.length >= 0.6 ? best : null;
}

function projectNext(lastDate: string, cadence: Cadence): string {
  const d = new Date(lastDate);
  d.setDate(d.getDate() + CADENCE_DAYS[cadence]);
  return d.toISOString().slice(0, 10);
}

/** Fetches recent debits and returns suggestions not already covered by an
 * existing subscription (name substring match, either direction). */
export async function detectRecurringSuggestions(opts: {
  lookbackDays?: number;
  minOccurrences?: number;
  amountTolerancePct?: number;
} = {}): Promise<RecurringSuggestion[]> {
  const lookbackDays = opts.lookbackDays ?? 180;
  const minOccurrences = opts.minOccurrences ?? 3;
  const amountTol = opts.amountTolerancePct ?? 0.15;

  const from = new Date();
  from.setDate(from.getDate() - lookbackDays);
  const fromIso = from.toISOString().slice(0, 10);

  const [{ data: txns }, { data: subs }] = await Promise.all([
    supabase.from("transactions")
      .select("id, txn_date, amount, merchant, description, category, financial_account_id, credit_card_id, txn_type")
      .eq("txn_type", "debit")
      .gte("txn_date", fromIso)
      .order("txn_date", { ascending: true })
      .limit(2000),
    supabase.from("subscriptions").select("name"),
  ]);

  const subNames = (subs ?? []).map((s: any) => normalizeMerchant(s.name)).filter(Boolean);
  const isCovered = (key: string) => subNames.some((n) => n && (n.includes(key) || key.includes(n)));

  interface Group { txns: any[]; }
  const groups = new Map<string, Group>();
  for (const t of txns ?? []) {
    const key = normalizeMerchant(t.merchant ?? t.description);
    if (!key || key.length < 3) continue;
    let g = groups.get(key);
    if (!g) { g = { txns: [] }; groups.set(key, g); }
    g.txns.push(t);
  }

  const out: RecurringSuggestion[] = [];
  for (const [key, g] of groups) {
    if (g.txns.length < minOccurrences) continue;
    if (isCovered(key)) continue;

    const amts = g.txns.map((t) => Number(t.amount) || 0).filter((n) => n > 0);
    if (amts.length < minOccurrences) continue;
    const med = median(amts);
    if (med <= 0) continue;
    const stable = amts.filter((a) => Math.abs(a - med) / med <= amountTol).length / amts.length;
    if (stable < 0.6) continue;

    const sorted = [...g.txns].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1].txn_date, sorted[i].txn_date));
    const cadence = detectCadence(gaps);
    if (!cadence) continue;

    const last = sorted[sorted.length - 1];
    // Prefer the linked account/card that appears most often in the group.
    const accountCounts = new Map<string, number>();
    const cardCounts = new Map<string, number>();
    for (const t of sorted) {
      if (t.financial_account_id) accountCounts.set(t.financial_account_id, (accountCounts.get(t.financial_account_id) ?? 0) + 1);
      if (t.credit_card_id) cardCounts.set(t.credit_card_id, (cardCounts.get(t.credit_card_id) ?? 0) + 1);
    }
    const pickTop = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    out.push({
      merchantKey: key,
      displayName: (last.merchant ?? last.description ?? key).trim().slice(0, 60),
      category: last.category ?? null,
      amount: Math.round(med * 100) / 100,
      cadence,
      occurrences: sorted.length,
      lastDate: last.txn_date,
      nextDueDate: projectNext(last.txn_date, cadence),
      financial_account_id: pickTop(accountCounts),
      credit_card_id: pickTop(cardCounts),
      sampleTxnIds: sorted.slice(-5).map((t) => t.id),
    });
  }

  // Highest confidence first: more occurrences, then higher amount.
  return out.sort((a, b) => b.occurrences - a.occurrences || b.amount - a.amount);
}
