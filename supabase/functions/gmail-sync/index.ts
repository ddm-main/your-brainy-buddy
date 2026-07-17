import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { svcClient } from "../_shared/gmail.ts";
import { runGmailSync } from "../_shared/gmail-sync-core.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const { account_id, max } = await req.json().catch(() => ({}));
    if (!account_id) return new Response(JSON.stringify({ error: "account_id required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    const svc = svcClient();
    const { data: account, error } = await svc.from("email_accounts").select("*").eq("id", account_id).eq("user_id", auth.userId).maybeSingle();
    if (error) throw error;
    if (!account) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    if (!account.refresh_token && !account.access_token) return new Response(JSON.stringify({ error: "account not connected" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    const startedAt = new Date().toISOString();
    const result = await runGmailSync(svc, account, max);
    // Log for the diagnostics strip (source=manual).
    await svc.from("gmail_sync_runs").insert({
      user_id: auth.userId,
      account_id: account.id,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      scanned: (result as any)?.total ?? 0,
      inserted: (result as any)?.inserted ?? 0,
      source: "manual",
    }).then(() => {}).catch(() => {});
    return new Response(JSON.stringify(result), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Gmail sync failed", "gmail-sync", cors);
  }
});
