// Standalone endpoint to (re-)extract structured finance records from stored
// emails. Called at the end of gmail-sync and from the Finance UI backfill.

import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { svcClient } from "../_shared/gmail.ts";
import { extractFinanceForAccount } from "../_shared/finance-extract-core.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const { account_id, since_days, limit } = await req.json().catch(() => ({}));
    const svc = svcClient();

    let accounts: any[] = [];
    if (account_id) {
      const { data, error } = await svc.from("email_accounts").select("*").eq("id", account_id).eq("user_id", auth.userId).maybeSingle();
      if (error) throw error;
      if (!data) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      accounts = [data];
    } else {
      const { data, error } = await svc.from("email_accounts").select("*").eq("user_id", auth.userId);
      if (error) throw error;
      accounts = data ?? [];
    }

    const results: any[] = [];
    let tx = 0, st = 0, sc = 0;
    for (const a of accounts) {
      try {
        const r = await extractFinanceForAccount(svc, a, { sinceDays: since_days, limit });
        tx += r.transactions; st += r.statements; sc += r.scanned;
        results.push({ account_id: a.id, email: a.email_address, ...r });
      } catch (e) {
        results.push({ account_id: a.id, email: a.email_address, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return new Response(JSON.stringify({ ok: true, transactions: tx, statements: st, scanned: sc, results }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("finance-extract:", msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
