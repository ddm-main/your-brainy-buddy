// Returns decrypted statement PDF passwords for the authenticated user's
// credit cards and financial accounts. Server-side decrypt only — plaintext
// leaves the function only to its authenticated owner.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { decryptStatementPassword, type StatementPasswordRule } from "../_shared/crypto.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";

const limiter = createSlidingWindowLimiter(20, 60_000);

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
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    const [cardsRes, accountsRes] = await Promise.all([
      supabase.from("credit_cards")
        .select("id, name, last_four, statement_password_rule, banks(name)")
        .eq("user_id", uid)
        .not("statement_password_rule", "is", null),
      supabase.from("financial_accounts")
        .select("id, nickname, masked_number, statement_password_rule, banks(name)")
        .eq("user_id", uid)
        .not("statement_password_rule", "is", null),
    ]);
    if (cardsRes.error) throw cardsRes.error;
    if (accountsRes.error) throw accountsRes.error;

    const decrypt = async (rule: unknown): Promise<string | null> => {
      try { return await decryptStatementPassword(rule as StatementPasswordRule); }
      catch { return null; }
    };

    const cards = await Promise.all((cardsRes.data ?? []).map(async (c: any) => ({
      type: "card" as const,
      id: c.id,
      label: c.name,
      bank: c.banks?.name ?? null,
      mask: c.last_four ? `••${c.last_four}` : null,
      password: await decrypt(c.statement_password_rule),
    })));
    const accounts = await Promise.all((accountsRes.data ?? []).map(async (a: any) => ({
      type: "account" as const,
      id: a.id,
      label: a.nickname,
      bank: a.banks?.name ?? null,
      mask: a.masked_number ?? null,
      password: await decrypt(a.statement_password_rule),
    })));

    return new Response(JSON.stringify({ items: [...cards, ...accounts] }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Could not load passwords", "finance-list-statement-passwords", cors);
  }
});
