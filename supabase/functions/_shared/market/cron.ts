// Guard for cron-invoked edge functions (deployed with verify_jwt=false).
// pg_cron sends the Vault-held secret in x-cron-secret. Edge functions first
// accept matching runtime secrets, then fall back to a service-role RPC that
// compares against Vault without exposing the secret value to the browser.
import { createClient } from "npm:@supabase/supabase-js@2";

// Plain `===`/Array.includes string comparison short-circuits on the first
// differing byte — a timing side-channel on a secret comparison. Length is
// checked up front (standard practice, including Node's own
// crypto.timingSafeEqual, which throws rather than compares on a length
// mismatch); only the byte-for-byte comparison itself needs to be constant-time.
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export async function requireCronSecret(req: Request): Promise<Response | null> {
  const expected = [
    Deno.env.get("CRON_SECRET"),
    Deno.env.get("SYNC_HOOK_SECRET"),
    Deno.env.get("MARKET_CRON_SECRET"),
  ].filter((v): v is string => Boolean(v && v.trim()));

  const got = req.headers.get("x-cron-secret");
  if (!got) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (expected.some((e) => timingSafeEqualStr(e, got))) return null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "cron secret not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const svc = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await svc.rpc("verify_market_cron_secret", { _secret: got });
  if (error || data !== true) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

// Today's NSE trade date (IST calendar day).
export function istTradeDate(d = new Date()): string {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  return ist.toISOString().slice(0, 10);
}

// Checked only where a wrong "market's open" call has real consequences —
// alerts firing on stale data, or AutoTrade placing an order — on an
// exchange holiday. Client-side polling-cadence checks (marketOpen() in
// src/lib/market/hooks.ts) stay calendar-only: worst case there is a few
// wasted polls on a holiday, not a wrong trade or a wrong alert.
export async function isTradingHoliday(
  svc: { from: (t: string) => any },
  dateStr: string,
  exchange = "NSE",
): Promise<boolean> {
  const { data } = await svc.from("market_holidays")
    .select("id").eq("holiday_date", dateStr).eq("exchange", exchange).maybeSingle();
  return !!data;
}
