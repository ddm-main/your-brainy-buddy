// Guard for cron-invoked edge functions (deployed with verify_jwt=false).
// pg_cron calls them with the Vault-held secret in x-cron-secret; the same
// value must be set as the CRON_SECRET edge-function secret.

export function requireCronSecret(req: Request): Response | null {
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected) {
    return new Response(JSON.stringify({ error: "CRON_SECRET not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const got = req.headers.get("x-cron-secret");
  if (got !== expected) {
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
