// Reconciles transactions against expected charges from subscriptions
// and loans (linked accounts). For each expected charge in the last 60d,
// finds a matching transaction within ±2 days and ±₹1. Missing charges
// or amount mismatches emit `finance_alerts` rows. Idempotent — the
// `expected_date + entity_id + type` triple dedupes.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";

const limiter = createSlidingWindowLimiter(6, 60_000);

function daysDiff(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400_000);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  const uid = auth.userId;

  const rl = limiter.check(uid);
  if (!rl.ok) return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }),
    { status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) } });

  try {
    const svc = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const since = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);

    // Load candidate transactions once.
    const { data: txns } = await svc.from("transactions")
      .select("id, amount, txn_date, txn_type, merchant, merchant_normalized")
      .eq("user_id", uid).gte("txn_date", since);
    const tlist = txns ?? [];

    // Subscriptions with a next_due_date in the last 60d.
    const { data: subs } = await svc.from("subscriptions")
      .select("id, name, amount, next_due_date, last_charged_at, is_active")
      .eq("user_id", uid).eq("is_active", true);

    // Loans with an EMI expected in the last 60d.
    const { data: loans } = await svc.from("loans")
      .select("id, lender_name, emi_amount, next_due_date, is_active")
      .eq("user_id", uid);

    const alertsToUpsert: any[] = [];
    const matchExpected = (amount: number, date: string) => {
      let best: any = null; let bestScore = Infinity;
      for (const t of tlist) {
        if (t.txn_type && t.txn_type !== "debit") continue;
        const dd = daysDiff(t.txn_date, date);
        if (dd > 2) continue;
        const ad = Math.abs((Number(t.amount) || 0) - amount);
        if (ad > 1) continue;
        const score = dd + ad / Math.max(1, amount);
        if (score < bestScore) { best = t; bestScore = score; }
      }
      return best;
    };

    const nowIso = new Date().toISOString().slice(0, 10);
    const emit = async (entity_type: "subscription" | "loan", entity_id: string, expected_amount: number, expected_date: string, name: string) => {
      const match = matchExpected(expected_amount, expected_date);
      // Only alert on past-due dates (don't yell about the future).
      if (expected_date > nowIso) return;
      if (!match) {
        alertsToUpsert.push({
          user_id: uid, type: "missing_charge", entity_type, entity_id,
          expected_amount, expected_date, status: "open",
          message: `Expected ${entity_type} charge for ${name} not found`,
        });
      } else if (Math.abs(Number(match.amount) - expected_amount) > 1) {
        alertsToUpsert.push({
          user_id: uid, type: "amount_mismatch", entity_type, entity_id,
          expected_amount, actual_amount: Number(match.amount), expected_date, status: "open",
          matched_transaction_id: match.id,
          message: `Amount mismatch for ${name}: expected ₹${expected_amount}, charged ₹${match.amount}`,
        });
      }
    };

    for (const s of (subs ?? [])) {
      if (!s.next_due_date || !s.amount) continue;
      await emit("subscription", s.id, Number(s.amount), s.next_due_date, s.name ?? "subscription");
    }
    for (const l of (loans ?? [])) {
      if (!l.next_due_date || !l.emi_amount) continue;
      await emit("loan", l.id, Number(l.emi_amount), l.next_due_date, l.lender_name ?? "loan");
    }

    // Idempotent: skip if an OPEN alert for the same tuple already exists.
    let inserted = 0;
    for (const a of alertsToUpsert) {
      const { data: existing } = await svc.from("finance_alerts").select("id")
        .eq("user_id", uid).eq("entity_type", a.entity_type).eq("entity_id", a.entity_id)
        .eq("expected_date", a.expected_date).eq("status", "open").maybeSingle();
      if (existing) continue;
      await svc.from("finance_alerts").insert(a);
      inserted++;
    }

    return new Response(JSON.stringify({
      ok: true, examined: (subs?.length ?? 0) + (loans?.length ?? 0), new_alerts: inserted,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Reconciliation failed", "finance-reconcile", cors);
  }
});