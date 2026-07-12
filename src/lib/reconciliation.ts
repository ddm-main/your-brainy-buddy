/** Client-side subscription/loan-vs-transactions reconciliation. No new edge
 * function — runs under the caller's own RLS-scoped session, triggered by
 * Finance Overview's "re-scan email" success path plus a standalone button.
 * Pure orchestration: fetches, compares, writes via db.ts. */

import { db } from "@/lib/db";

const WINDOW_DAYS = 5;
const TOLERANCE_MIN = 5; // rupees, floor for tiny expected amounts
const TOLERANCE_PCT = 0.02;

type EntityType = "subscription" | "loan";

interface ReconcilableEntity {
  entityType: EntityType;
  entityId: string;
  expectedAmount: number | null;
  expectedDate: string | null;
  financial_account_id: string | null;
  credit_card_id: string | null;
}

export interface ReconciliationSummary {
  checked: number;
  matched: number;
  mismatched: number;
  missing: number;
  skipped: number;
}

function keyOf(entityType: string, entityId: string, expectedDate: string): string {
  return `${entityType}:${entityId}:${expectedDate}`;
}

/** Runs one reconciliation pass over every subscription/loan whose expected
 * charge date has already arrived. Idempotent: alerts are keyed on
 * (entity_type, entity_id, expected_date) and re-running never duplicates.
 * Dismissed/resolved alerts are sticky — never resurrected by a later run. */
export async function runReconciliation(): Promise<ReconciliationSummary> {
  const [subs, loans, existingAlerts] = await Promise.all([
    db.subscriptions.list(),
    db.loans.list(),
    db.alerts.list(),
  ]);

  const alertByKey = new Map<string, any>();
  for (const a of existingAlerts) alertByKey.set(keyOf(a.entity_type, a.entity_id, a.expected_date), a);

  const today = new Date().toISOString().slice(0, 10);
  const summary: ReconciliationSummary = { checked: 0, matched: 0, mismatched: 0, missing: 0, skipped: 0 };

  const entities: ReconcilableEntity[] = [
    ...subs.map((s: any) => ({
      entityType: "subscription" as const,
      entityId: s.id,
      expectedAmount: s.amount != null ? Number(s.amount) : null,
      expectedDate: s.next_due_date ?? null,
      financial_account_id: s.linked_account_id ?? null,
      credit_card_id: s.linked_card_id ?? null,
    })),
    ...loans.map((l: any) => ({
      entityType: "loan" as const,
      entityId: l.id,
      expectedAmount: l.emi_amount != null ? Number(l.emi_amount) : null,
      expectedDate: l.next_due_date ?? null,
      financial_account_id: l.linked_account_id ?? null,
      credit_card_id: null,
    })),
  ];

  for (const e of entities) {
    if (!e.expectedDate || e.expectedDate > today) continue; // not due yet — nothing to check
    if (!e.financial_account_id && !e.credit_card_id) { summary.skipped++; continue; } // nothing linked to check against
    if (e.expectedAmount == null) { summary.skipped++; continue; } // can't judge a match without an expected amount

    summary.checked++;
    const key = keyOf(e.entityType, e.entityId, e.expectedDate);
    const existing = alertByKey.get(key);
    if (existing && (existing.status === "dismissed" || existing.status === "resolved")) continue;

    const candidates = await db.transactions.findInWindow({
      financial_account_id: e.financial_account_id,
      credit_card_id: e.credit_card_id,
      centerDate: e.expectedDate,
      windowDays: WINDOW_DAYS,
    });

    const tolerance = Math.max(TOLERANCE_MIN, e.expectedAmount * TOLERANCE_PCT);
    let best: any = null;
    let bestDiff = Infinity;
    for (const c of candidates) {
      const diff = Math.abs(Number(c.amount) - e.expectedAmount);
      if (diff < bestDiff) { best = c; bestDiff = diff; }
    }

    if (best && bestDiff <= tolerance) {
      summary.matched++;
      if (!best.is_reconciled) await db.transactions.update(best.id, { is_reconciled: true });
      if (existing) await db.alerts.resolve(existing.id);
    } else if (best) {
      summary.mismatched++;
      const patch = {
        type: "amount_mismatch", entity_type: e.entityType, entity_id: e.entityId,
        expected_amount: e.expectedAmount, actual_amount: Number(best.amount), expected_date: e.expectedDate,
        message: `Expected ${e.expectedAmount}, found ${best.amount} on ${best.txn_date}`,
        matched_transaction_id: best.id, status: "open",
      };
      if (existing) await db.alerts.update(existing.id, patch); else await db.alerts.create(patch);
    } else {
      summary.missing++;
      const patch = {
        type: "missing_charge", entity_type: e.entityType, entity_id: e.entityId,
        expected_amount: e.expectedAmount, actual_amount: null, expected_date: e.expectedDate,
        message: `No matching charge found around ${e.expectedDate}`,
        matched_transaction_id: null, status: "open",
      };
      if (existing) await db.alerts.update(existing.id, patch); else await db.alerts.create(patch);
    }
  }

  return summary;
}
