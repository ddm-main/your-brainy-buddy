// Nightly detectors — runs salary/investment/duplicate/anomaly detection
// and budget threshold checks. Writes to finance_suggestions + finance_alerts.
// Callable manually (POST with JWT) or by cron (shared-secret header).

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function admin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

function normalize(raw?: string | null): string {
  if (!raw) return "";
  return raw.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

async function runForUser(userId: string) {
  const db = admin();
  const from = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const { data: txns } = await db.from("transactions")
    .select("id, txn_date, amount, txn_type, merchant, description, category, source")
    .eq("user_id", userId).gte("txn_date", from).order("txn_date");
  const { data: budgets } = await db.from("budgets").select("category, monthly_limit, active").eq("user_id", userId);

  const suggestions: Array<{ kind: string; payload: any }> = [];

  // Salary
  const credits = (txns ?? []).filter((t: any) => t.txn_type === "credit" && Number(t.amount) >= 20000);
  const salaryGroups = new Map<string, any[]>();
  for (const t of credits) {
    const k = normalize(t.merchant ?? t.description) || "credit";
    (salaryGroups.get(k) ?? salaryGroups.set(k, []).get(k)!).push(t);
  }
  for (const [k, g] of salaryGroups) {
    if (g.length < 2) continue;
    const amts = g.map((t: any) => Number(t.amount));
    const med = [...amts].sort((a, b) => a - b)[Math.floor(amts.length / 2)];
    const stable = amts.filter((a) => Math.abs(a - med) / med <= 0.15).length / amts.length;
    if (stable < 0.6) continue;
    suggestions.push({ kind: "salary", payload: { merchant: k, amount: Math.round(med), occurrences: g.length } });
  }

  // Investment
  const INV = /\b(sip|mf|mutual\s*fund|zerodha|groww|indmoney|coin|kuvera|smallcase|nps|ppf|elss)\b/i;
  const invGroups = new Map<string, any[]>();
  for (const t of txns ?? []) {
    if ((t as any).txn_type !== "debit") continue;
    if (!INV.test(`${(t as any).merchant ?? ""} ${(t as any).description ?? ""}`)) continue;
    const k = ((t as any).merchant ?? "investment").toLowerCase();
    (invGroups.get(k) ?? invGroups.set(k, []).get(k)!).push(t);
  }
  for (const [k, g] of invGroups) {
    suggestions.push({ kind: "investment", payload: { merchant: k, occurrences: g.length, total: g.reduce((s: number, t: any) => s + Number(t.amount), 0) } });
  }

  // Duplicates (last 30d only for cost)
  const recent = (txns ?? []).filter((t: any) => t.txn_date >= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const a: any = recent[i], b: any = recent[j];
      const dd = Math.abs((new Date(b.txn_date).getTime() - new Date(a.txn_date).getTime()) / 86400000);
      if (dd > 2) break;
      if (a.txn_type !== b.txn_type || Number(a.amount) !== Number(b.amount)) continue;
      const ma = normalize(a.merchant ?? a.description);
      const mb = normalize(b.merchant ?? b.description);
      if (!ma || !mb || !(ma === mb || ma.includes(mb) || mb.includes(ma))) continue;
      if (a.source && b.source && a.source === b.source) continue;
      suggestions.push({ kind: "duplicate", payload: { keepId: a.id, duplicateId: b.id, amount: Number(a.amount), merchant: a.merchant ?? ma } });
    }
  }

  // Anomalies (per-category stddev)
  const debits = (txns ?? []).filter((t: any) => t.txn_type === "debit");
  const byCat = new Map<string, any[]>();
  for (const t of debits) {
    const c = (t as any).category ?? "Uncategorized";
    (byCat.get(c) ?? byCat.set(c, []).get(c)!).push(t);
  }
  for (const [cat, arr] of byCat) {
    if (arr.length < 5) continue;
    const amts = arr.map((t: any) => Number(t.amount));
    const mean = amts.reduce((s: number, a: number) => s + a, 0) / amts.length;
    const sd = Math.sqrt(amts.reduce((s: number, a: number) => s + (a - mean) ** 2, 0) / amts.length);
    for (const t of arr) {
      const a = Number((t as any).amount);
      if (sd > 0 && a > mean + 3 * sd && a > mean * 2) {
        suggestions.push({ kind: "anomaly", payload: { txnId: (t as any).id, amount: a, category: cat, merchant: (t as any).merchant, detail: `${Math.round((a / mean) * 10) / 10}× category avg` } });
      }
    }
  }

  // Budgets → finance_alerts
  const period = new Date().toISOString().slice(0, 7);
  const spendByCat = new Map<string, number>();
  for (const t of debits) {
    if (((t as any).txn_date ?? "").slice(0, 7) !== period) continue;
    const c = (t as any).category ?? "Uncategorized";
    spendByCat.set(c, (spendByCat.get(c) ?? 0) + Number((t as any).amount));
  }
  const alerts: Array<{ kind: string; message: string; severity: string }> = [];
  for (const b of budgets ?? []) {
    if ((b as any).active === false) continue;
    const spent = spendByCat.get((b as any).category) ?? 0;
    const pct = (b as any).monthly_limit > 0 ? (spent / (b as any).monthly_limit) * 100 : 0;
    if (pct >= 100) alerts.push({ kind: "budget_over", message: `Over budget: ${(b as any).category} ${Math.round(pct)}%`, severity: "high" });
    else if (pct >= 80) alerts.push({ kind: "budget_warn", message: `${Math.round(pct)}% of ${(b as any).category} budget used`, severity: "medium" });
  }

  // Write suggestions (dedup by kind+payload hash via unique-ish check on payload keys)
  let written = 0;
  for (const s of suggestions) {
    // avoid piling up dupes: check for an existing pending row with same kind + primary payload key
    const { data: existing } = await db.from("finance_suggestions").select("id")
      .eq("user_id", userId).eq("kind", s.kind).eq("status", "pending")
      .contains("payload", s.payload).limit(1);
    if (existing && existing.length) continue;
    const { error } = await db.from("finance_suggestions").insert({ user_id: userId, kind: s.kind, payload: s.payload, status: "pending" });
    if (!error) written++;
  }

  // finance_alerts insert (table shape assumed: user_id, kind, message, severity, status)
  for (const a of alerts) {
    await db.from("finance_alerts").insert({ user_id: userId, alert_type: a.kind, message: a.message, severity: a.severity, status: "open" }).select();
  }

  return { suggestions_written: written, alerts_written: alerts.length };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const cronSecret = req.headers.get("x-cron-secret");
  const expectedSecret = Deno.env.get("SYNC_HOOK_SECRET");

  try {
    if (cronSecret && expectedSecret && cronSecret === expectedSecret) {
      // Cron path — iterate over all users with any transactions
      const db = admin();
      const { data: users } = await db.from("transactions").select("user_id").limit(1000);
      const unique = [...new Set((users ?? []).map((u: any) => u.user_id))];
      const results = [];
      for (const uid of unique) results.push({ userId: uid, ...(await runForUser(uid)) });
      return new Response(JSON.stringify({ ok: true, users: results }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const auth = await requireUserId(req);
    if ("error" in auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const result = await runForUser(auth.userId);
    return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Detect failed", "finance-detect", cors);
  }
});