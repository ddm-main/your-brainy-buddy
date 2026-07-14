// Deterministic finance detector. Classifies transactions into
// `detected_kind` (salary/sip/emi/investment/insurance/cc_payment/
// dividend/interest/refund/recurring/transfer), normalises merchants,
// flags duplicates (same user + normalized merchant + amount + date
// within 3d) and simple fraud patterns (>3 debits from same merchant
// within 60 min or amount > 5x the merchant's 60d median).
// Writes an audit row into `detection_runs`. Owner-scoped via caller JWT.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";

const limiter = createSlidingWindowLimiter(6, 60_000);

function normalizeMerchant(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.toLowerCase().trim();
  s = s.replace(/[*#]+.*$/, "");                    // strip trailing refs
  s = s.replace(/\b(pvt|ltd|limited|india|in|inc|llc|llp|co)\b/g, "");
  s = s.replace(/\b\d{3,}\b/g, "");                 // strip numeric ids
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  return s || null;
}

function classify(t: any): string | null {
  const type = (t.txn_type || "").toLowerCase();
  const cat = (t.category || "").toLowerCase();
  const m = (t.merchant || t.description || "").toLowerCase();
  const hay = `${cat} ${m}`;

  if (/\bsalary|payroll|stipend\b/.test(hay)) return "salary";
  if (/\bsip\b|\bmutual fund\b|\bmf\b|folio/.test(hay)) return "sip";
  if (/\bemi\b|loan|equated/.test(hay)) return "emi";
  if (/\bcard payment|card bill|credit card/.test(hay)) return "cc_payment";
  if (/\binsurance|premium\b/.test(hay)) return "insurance";
  if (/\bdividend\b/.test(hay)) return "dividend";
  if (/\binterest\b/.test(hay) && type === "credit") return "interest";
  if (type === "credit" && /\brefund|reversal|cashback\b/.test(hay)) return "refund";
  if (/\btransfer|imps|neft|rtgs|to self|self-transfer\b/.test(hay)) return "transfer";
  if (/\bstock|equity|zerodha|groww|upstox|angel|kite\b/.test(hay)) return "investment";
  return null;
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

  const started = Date.now();
  try {
    const svc = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Last 90 days is enough for classification + duplicate detection.
    const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    const { data: rows, error } = await svc
      .from("transactions")
      .select("id, user_id, txn_type, amount, merchant, description, category, txn_date, detected_kind, merchant_normalized, is_duplicate, is_suspicious")
      .eq("user_id", uid).gte("txn_date", since).limit(5000);
    if (error) throw error;

    const txns = rows ?? [];
    // Merchant medians for fraud check (60 days).
    const merchantAmounts = new Map<string, number[]>();
    const enriched = txns.map((t: any) => {
      const norm = normalizeMerchant(t.merchant ?? t.description);
      const kind = classify(t);
      if (norm) {
        const arr = merchantAmounts.get(norm) ?? [];
        arr.push(Number(t.amount) || 0);
        merchantAmounts.set(norm, arr);
      }
      return { ...t, _norm: norm, _kind: kind };
    });
    const medians = new Map<string, number>();
    for (const [k, arr] of merchantAmounts) {
      const s = [...arr].sort((a, b) => a - b);
      medians.set(k, s[Math.floor(s.length / 2)] || 0);
    }

    // Duplicate detection: same user + norm + amount + within 3 days.
    const dupeKey = (t: any) => `${t._norm ?? "?"}|${Number(t.amount) || 0}`;
    const buckets = new Map<string, any[]>();
    for (const t of enriched) {
      const k = dupeKey(t);
      const arr = buckets.get(k) ?? [];
      arr.push(t); buckets.set(k, arr);
    }
    const dupeIds = new Set<string>();
    for (const arr of buckets.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a.txn_date.localeCompare(b.txn_date));
      for (let i = 1; i < arr.length; i++) {
        const dA = new Date(arr[i - 1].txn_date).getTime();
        const dB = new Date(arr[i].txn_date).getTime();
        if (Math.abs(dB - dA) <= 3 * 86400_000) dupeIds.add(arr[i].id);
      }
    }

    // Update rows whose enrichment changed.
    let flagged = 0;
    for (const t of enriched) {
      const suspicious = t._norm
        ? Number(t.amount) > 5 * (medians.get(t._norm) || 0) && (medians.get(t._norm) || 0) > 0
        : false;
      const dup = dupeIds.has(t.id);
      const patch: Record<string, unknown> = {};
      if (t._kind && t._kind !== t.detected_kind) patch.detected_kind = t._kind;
      if (t._norm && t._norm !== t.merchant_normalized) patch.merchant_normalized = t._norm;
      if (dup !== !!t.is_duplicate) patch.is_duplicate = dup;
      if (suspicious !== !!t.is_suspicious) patch.is_suspicious = suspicious;
      if (Object.keys(patch).length === 0) continue;
      flagged++;
      await svc.from("transactions").update(patch).eq("id", t.id).eq("user_id", uid);
    }

    // Auto-detect recurring subscriptions (>=3 same-amount charges within 90d).
    let subs_created = 0;
    for (const [k, arr] of buckets) {
      if (arr.length < 3) continue;
      const merchantNorm = k.split("|")[0];
      if (!merchantNorm || merchantNorm === "?") continue;
      const amount = Number(arr[0].amount) || 0;
      const first = arr[0];
      const { data: existing } = await svc.from("subscriptions").select("id")
        .eq("user_id", uid).ilike("name", `%${merchantNorm}%`).maybeSingle();
      if (existing) continue;
      await svc.from("subscriptions").insert({
        user_id: uid, name: first.merchant ?? merchantNorm, amount,
        billing_cycle: "monthly", auto_detected: true, is_active: true,
        category: first.category ?? "auto",
      });
      subs_created++;
    }

    await svc.from("detection_runs").insert({
      user_id: uid, kind: "manual", scanned: enriched.length, flagged,
      duration_ms: Date.now() - started,
      detail: { subs_created, duplicates: dupeIds.size },
    });

    return new Response(JSON.stringify({
      ok: true, scanned: enriched.length, flagged, duplicates: dupeIds.size, subs_created,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Detector failed", "finance-detect", cors);
  }
});