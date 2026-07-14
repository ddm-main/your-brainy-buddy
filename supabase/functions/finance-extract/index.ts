// Standalone endpoint to (re-)extract structured finance records from stored
// emails. Called at the end of gmail-sync and from the Finance UI backfill.

import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { svcClient } from "../_shared/gmail.ts";
import { extractFinanceForAccount } from "../_shared/finance-extract-core.ts";
import { sanitizeError, sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";
import { z } from "npm:zod";

const limiter = createSlidingWindowLimiter(20, 60_000);
const Body = z.object({
  account_id: z.string().uuid().optional(),
  since_days: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

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
    const { account_id, since_days, limit } = parsed.data;
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
        const safe = sanitizeError(e, "Finance extraction failed", `finance-extract:${a.id}`);
        results.push({ account_id: a.id, email: a.email_address, error: safe.error });
      }
    }
    return new Response(JSON.stringify({ ok: true, transactions: tx, statements: st, scanned: sc, results }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Finance extraction failed", "finance-extract", cors);
  }
});
