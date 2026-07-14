import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { svcClient } from "../_shared/gmail.ts";
import { runGmailSync } from "../_shared/gmail-sync-core.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";
import { z } from "npm:zod";

const limiter = createSlidingWindowLimiter(30, 60_000);
const Body = z.object({ account_id: z.string().uuid(), max: z.number().int().min(1).max(500).optional() });

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
    const { account_id, max } = parsed.data;

    const svc = svcClient();
    const { data: account, error } = await svc.from("email_accounts").select("*").eq("id", account_id).eq("user_id", auth.userId).maybeSingle();
    if (error) throw error;
    if (!account) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    if (!account.refresh_token && !account.access_token) return new Response(JSON.stringify({ error: "account not connected" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    const result = await runGmailSync(svc, account, max);
    return new Response(JSON.stringify(result), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Gmail sync failed", "gmail-sync", cors);
  }
});
