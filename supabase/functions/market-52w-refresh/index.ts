// market-52w-refresh — recomputes 52-week high/low from Yahoo v8/chart data
// (adjusted for splits/dividends by Yahoo itself). Writes back to
// market_stock_scores.high_52w / low_52w AND market_fundamentals_global.
// Chunked and jittered to respect Yahoo rate limits.
import { preflight, jsonResponse, errorResponse, svcClient, corsFor } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";

const CHUNK = 150;
const CONCURRENCY = 4;
const UA = "Mozilla/5.0 (Jarvis 52w-refresh)";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchYahoo52w(symbol: string): Promise<{ high: number; low: number; asOf: number } | null> {
  for (const suf of [".NS", ".BO"]) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + suf)}?range=1y&interval=1d&events=div,splits&includeAdjustedClose=true`;
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const body = await r.json();
      const result = body?.chart?.result?.[0];
      if (!result) continue;
      const quote = result.indicators?.quote?.[0];
      const adj = result.indicators?.adjclose?.[0]?.adjclose;
      const highs: number[] = quote?.high ?? [];
      const lows: number[] = quote?.low ?? [];
      const closes: number[] = adj ?? quote?.close ?? [];
      // Use adjusted-close-scaled high/low (Yahoo already applies split factor
      // to open/high/low; adjclose applies dividend on top). For 52w extremes
      // Tickertape uses split-adjusted only, so raw high/low is closer.
      const cleanH = highs.filter((v) => typeof v === "number" && v > 0);
      const cleanL = lows.filter((v) => typeof v === "number" && v > 0);
      if (cleanH.length === 0 || cleanL.length === 0) continue;
      return {
        high: Math.max(...cleanH),
        low: Math.min(...cleanL),
        asOf: Date.now(),
      };
    } catch { /* try next suffix */ }
  }
  return null;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const cronGuard = await requireCronSecret(req);
  if (cronGuard) return cronGuard;

  try {
    const svc = svcClient();
    // Prioritize active NSE equities whose 52w row is missing or older than 7 days.
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data: stale } = await svc
      .from("market_stock_scores")
      .select("symbol,exchange,computed_at,high_52w")
      .eq("exchange", "NSE")
      .or(`high_52w.is.null,computed_at.lt.${cutoff}`)
      .limit(CHUNK * 4);
    const work = (stale ?? []).slice(0, CHUNK).map((r: any) => ({ symbol: r.symbol, exchange: r.exchange }));

    let updated = 0, failed = 0;
    const started = Date.now();

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const item = work.shift();
        if (!item) break;
        try {
          const res = await fetchYahoo52w(item.symbol);
          if (!res) { failed++; await sleep(150); continue; }
          const { high, low } = res;
          const patches = [
            svc.from("market_stock_scores").update({ high_52w: high, low_52w: low }).eq("symbol", item.symbol).eq("exchange", item.exchange),
            svc.from("market_fundamentals_global").update({ high_52w: high, low_52w: low, updated_at: new Date().toISOString() }).eq("symbol", item.symbol).eq("exchange", item.exchange),
          ];
          await Promise.all(patches);
          updated++;
        } catch { failed++; }
        await sleep(200 + Math.random() * 200);
      }
    });
    await Promise.all(workers);

    await svc.from("market_ingestion_runs").insert({
      source: "yahoo_52w_refresh", stage: "fetch",
      status: failed > updated ? "partial" : "ok",
      rows_ingested: updated, duration_ms: Date.now() - started,
      metadata: { failed, attempted: updated + failed },
      finished_at: new Date().toISOString(),
    });

    return jsonResponse(req, { ok: true, updated, failed, drained: (updated + failed) < CHUNK });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});