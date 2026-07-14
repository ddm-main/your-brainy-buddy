import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { ensureAccessToken, extractBody, gapi, svcClient } from "../_shared/gmail.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";
import { z } from "npm:zod";

const limiter = createSlidingWindowLimiter(60, 60_000);
const Body = z.object({ email_id: z.string().uuid() });

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  const rl = limiter.check(auth.userId);
  if (!rl.ok) return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
    status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
  });

  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return new Response(JSON.stringify({ error: "invalid_input", details: parsed.error.flatten() }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const { email_id } = parsed.data;
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
    return sanitizedErrorResponse(err, "Could not load that email", "gmail-message", cors);
  }
});
