import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { ensureAccessToken, extractBody, gapi, svcClient } from "../_shared/gmail.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const { email_id } = await req.json();
    if (!email_id) return new Response(JSON.stringify({ error: "email_id required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const svc = svcClient();
    const { data: row, error } = await svc.from("emails").select("id, user_id, account_id, external_email_id, body_text, body_html").eq("id", email_id).eq("user_id", auth.userId).maybeSingle();
    if (error) throw error;
    if (!row) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    if (row.body_text || row.body_html) return new Response(JSON.stringify({ body_text: row.body_text, body_html: row.body_html }), { headers: { ...cors, "Content-Type": "application/json" } });

    const { data: account } = await svc.from("email_accounts").select("*").eq("id", row.account_id).maybeSingle();
    if (!account) return new Response(JSON.stringify({ error: "account missing" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    const token = await ensureAccessToken(svc, account);
    const full = await gapi(token, `/gmail/v1/users/me/messages/${row.external_email_id}?format=full`);
    const { text, html } = extractBody(full.payload);

    await svc.from("emails").update({ body_text: text, body_html: html }).eq("id", row.id);
    return new Response(JSON.stringify({ body_text: text, body_html: html }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("gmail-message:", msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
