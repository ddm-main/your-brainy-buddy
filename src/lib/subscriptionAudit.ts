/** Anomaly checks over EXISTING subscriptions — duplicate detection, price
 * changes, and unused subscriptions. Complements recurringDetector.ts,
 * which only finds NEW un-tracked recurring charges; this audits the ones
 * already added. Deterministic, no AI, no writes — same independent style
 * as recurringDetector.ts (direct reads, caller owns rendering). */

import { supabase } from "@/integrations/supabase/client";
import { normalizeMerchant } from "@/lib/recurringDetector";

export interface SubscriptionFinding {
  subId: string;
  kind: "duplicate" | "price_change" | "unused";
  severity: "warn" | "danger";
  otherName?: string;      // duplicate: the other subscription's name
  expectedAmount?: number; // price_change / unused: the subscription's tracked amount
  closestAmount?: number;  // price_change: the most recent charge that roughly matches
  lookbackDays?: number;   // unused: how far back was searched
}

const CYCLE_DAYS: Record<string, number> = { weekly: 7, monthly: 30, quarterly: 91, yearly: 365 };

export async function auditSubscriptions(subs: Array<Record<string, any>>): Promise<SubscriptionFinding[]> {
  const findings: SubscriptionFinding[] = [];

  // --- Duplicates: pairwise compare by normalized name + amount within 10% ---
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      const a = subs[i], b = subs[j];
      const na = normalizeMerchant(a.name), nb = normalizeMerchant(b.name);
      if (!na || !nb) continue;
      if (na !== nb && !na.includes(nb) && !nb.includes(na)) continue;
      const amtA = Number(a.amount) || 0, amtB = Number(b.amount) || 0;
      if (amtA <= 0 || amtB <= 0) continue;
      if (Math.abs(amtA - amtB) / Math.max(amtA, amtB) > 0.1) continue;
      findings.push({ subId: a.id, kind: "duplicate", severity: "warn", otherName: b.name });
      findings.push({ subId: b.id, kind: "duplicate", severity: "warn", otherName: a.name });
    }
  }

  // --- Price change / unused: needs a linked account or card to check transactions against ---
  for (const s of subs) {
    if (!s.linked_account_id && !s.linked_card_id) continue;
    const expected = Number(s.amount) || 0;
    if (expected <= 0) continue;

    const cycleDays = CYCLE_DAYS[s.billing_cycle as string] ?? 30;
    const lookbackDays = cycleDays * 3; // last ~3 billing cycles
    const from = new Date();
    from.setDate(from.getDate() - lookbackDays);

    let q = supabase.from("transactions").select("txn_date, amount")
      .eq("txn_type", "debit")
      .gte("txn_date", from.toISOString().slice(0, 10))
      .order("txn_date", { ascending: false })
      .limit(50);
    q = s.linked_card_id ? q.eq("credit_card_id", s.linked_card_id) : q.eq("financial_account_id", s.linked_account_id);
    const { data: txns } = await q;

    if (!txns || txns.length === 0) {
      findings.push({ subId: s.id, kind: "unused", severity: "danger", expectedAmount: expected, lookbackDays });
      continue;
    }

    // No merchant/description link exists between subscriptions and
    // transactions — the closest-amount charge in the window is the best
    // available proxy for "the actual subscription charge." Far off (or
    // absent) -> likely cancelled/unused; moderately off -> likely a price
    // change; close -> no finding.
    let closest = txns[0];
    let bestDiff = Math.abs((Number(closest.amount) || 0) - expected);
    for (const t of txns) {
      const diff = Math.abs((Number(t.amount) || 0) - expected);
      if (diff < bestDiff) { bestDiff = diff; closest = t; }
    }
    const closestAmount = Number(closest.amount) || 0;
    const diffPct = bestDiff / expected;
    if (diffPct > 0.5) {
      findings.push({ subId: s.id, kind: "unused", severity: "danger", expectedAmount: expected, lookbackDays });
    } else if (diffPct > 0.05) {
      findings.push({ subId: s.id, kind: "price_change", severity: "warn", expectedAmount: expected, closestAmount });
    }
  }

  return findings;
}
