// Encrypts and stores a bank/card statement password server-side. The
// plaintext is never written to a table and never echoed back — only a
// boolean "has password" can be derived client-side from whether
// statement_password_rule is non-null.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { encryptStatementPassword } from "../_shared/crypto.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";
import { z } from "npm:zod";

const limiter = createSlidingWindowLimiter(20, 60_000);
const Body = z.object({
  target_type: z.enum(["card", "account"]),
  target_id: z.string().uuid(),
  password: z.string().min(1).max(256),
});

const TABLES: Record<string, string> = {
  card: "credit_cards",
  account: "financial_accounts",
};

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const uid = auth.userId;
  const rl = limiter.check(uid);
  if (!rl.ok) return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
    status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
  });

  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return new Response(JSON.stringify({ error: "invalid_input", details: parsed.error.flatten() }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const { target_type, target_id, password } = parsed.data;
    const table = TABLES[target_type];

    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    // Ownership check — belt-and-suspenders beyond RLS, since the
    // service-role client bypasses RLS entirely.
    const { data: row, error: findErr } = await supabase
      .from(table)
      .select("id, user_id")
      .eq("id", target_id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!row || row.user_id !== uid) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const rule = await encryptStatementPassword(password);
    const { error: updErr } = await supabase
      .from(table)
      .update({ statement_password_rule: rule })
      .eq("id", target_id);
    if (updErr) throw updErr;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Could not save that password", "finance-set-statement-password", cors);
  }
});
