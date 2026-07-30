// market-shoonya-master-sync — mirror Shoonya's instrument tokens into
// market_stocks.shoonya_token.
//
// Every Noren data route (GetQuotes, TPSeries, WS touchline) is keyed by an
// instrument token, not a symbol, so the provider is useless until this has
// run at least once. Idempotent: only rows whose token actually changed are
// written, which makes the daily cron a near-no-op after the first pass.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { fetchShoonyaMaster } from "../_shared/market/shoonyaMaster.ts";

const CONCURRENCY = 16;

async function runPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await fn(item);
      }
    }),
  );
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;

  // Cron secret OR an admin user — the nightly job has no user context.
  const cronDenied = await requireCronSecret(req);
  if (cronDenied) {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
    const svcAuth = svcClient();
    const { data: admin } = await svcAuth.from("user_roles")
      .select("role").eq("user_id", auth.userId).eq("role", "admin").maybeSingle();
    if (!admin) return new Response("forbidden", { status: 403, headers: corsFor(req) });
  }

  const svc = svcClient();
  const body = await req.json().catch(() => ({}));
  const segments: Array<"NSE" | "BSE"> = Array.isArray((body as any)?.exchanges)
    ? (body as any).exchanges.filter((e: string) => e === "NSE" || e === "BSE")
    : ["NSE"];

  const summary: Record<string, unknown> = {};
  try {
    for (const seg of segments) {
      const rows = await fetchShoonyaMaster(seg);
      const bySymbol = new Map(rows.map((r) => [r.symbol, r]));

      // Existing universe rows for this exchange (paged — PostgREST caps at 1000).
      const existing: Array<{ symbol: string; shoonya_token: string | null }> = [];
      for (let from = 0; from < 40_000; from += 1000) {
        const { data, error } = await svc.from("market_stocks")
          .select("symbol,shoonya_token").eq("exchange", seg)
          .range(from, from + 999);
        if (error) throw new Error(error.message);
        const page = data ?? [];
        existing.push(...(page as any[]));
        if (page.length < 1000) break;
      }

      const changed = existing.filter((r) => {
        const m = bySymbol.get(String(r.symbol).toUpperCase());
        return m && m.token !== r.shoonya_token;
      });

      let updated = 0;
      const failures: string[] = [];
      await runPool(changed, async (r) => {
        const m = bySymbol.get(String(r.symbol).toUpperCase())!;
        const { error } = await svc.from("market_stocks")
          .update({ shoonya_token: m.token })
          .eq("symbol", r.symbol).eq("exchange", seg);
        if (error) { if (failures.length < 5) failures.push(`${r.symbol}: ${error.message}`); return; }
        updated++;
      });

      summary[seg] = {
        master_rows: rows.length,
        universe_rows: existing.length,
        updated,
        unmatched_in_master: existing.filter((r) => !bySymbol.has(String(r.symbol).toUpperCase())).length,
        failures,
      };
    }
    return jsonResponse(req, { ok: true, summary });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
