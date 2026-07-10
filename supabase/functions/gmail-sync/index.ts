import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { ensureAccessToken, gapi, parseFrom, parseHeaders, svcClient } from "../_shared/gmail.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const { account_id, max = 50 } = await req.json().catch(() => ({}));
    if (!account_id) return new Response(JSON.stringify({ error: "account_id required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    const svc = svcClient();
    const { data: account, error } = await svc.from("email_accounts").select("*").eq("id", account_id).eq("user_id", auth.userId).maybeSingle();
    if (error) throw error;
    if (!account) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    if (!account.refresh_token && !account.access_token) return new Response(JSON.stringify({ error: "account not connected" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    await svc.from("email_accounts").update({ sync_status: "syncing", last_error: null }).eq("id", account_id);

    let inserted = 0;
    let latestHistoryId: string | null = null;
    try {
      const token = await ensureAccessToken(svc, account);
      const list = await gapi(token, `/gmail/v1/users/me/messages?q=${encodeURIComponent("newer_than:30d in:inbox")}&maxResults=${Math.min(max, 100)}`);
      const ids: { id: string; threadId: string }[] = list.messages ?? [];
      latestHistoryId = list.historyId || null;

      for (const m of ids) {
        // Skip if already stored.
        const { data: existing } = await svc.from("emails").select("id").eq("user_id", auth.userId).eq("account_id", account_id).eq("external_email_id", m.id).maybeSingle();
        if (existing) continue;

        const meta = await gapi(token, `/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`);
        const h = parseHeaders(meta.payload?.headers ?? []);
        const from = parseFrom(h["from"]);
        const receivedAt = meta.internalDate ? new Date(Number(meta.internalDate)).toISOString() : null;

        const { error: insErr } = await svc.from("emails").insert({
          user_id: auth.userId,
          account_id,
          provider: "gmail",
          external_email_id: m.id,
          thread_id: m.threadId,
          from_name: from.name,
          from_email: from.email,
          subject: h["subject"] ?? null,
          snippet: meta.snippet ?? null,
          received_at: receivedAt,
        });
        if (!insErr) inserted++;
        else if (!String(insErr.message).includes("duplicate")) console.warn("insert failed", insErr.message);
      }

      await svc.from("email_accounts").update({
        sync_status: "ok",
        last_synced_at: new Date().toISOString(),
        history_id: latestHistoryId,
        last_error: null,
      }).eq("id", account_id);

      return new Response(JSON.stringify({ ok: true, inserted, total: ids.length }), { headers: { ...cors, "Content-Type": "application/json" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await svc.from("email_accounts").update({ sync_status: "error", last_error: msg }).eq("id", account_id);
      throw e;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("gmail-sync:", msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
