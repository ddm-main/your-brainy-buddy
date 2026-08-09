// market-52w-refresh — recomputes 52-week high/low. Kotak-first via
// getServiceProvider (uses provider.getOHLCV, which itself falls back to
// Yahoo per-symbol); the direct Yahoo v8/chart fetch is a last-resort
// fallback only when the provider throws. Writes back to
// market_stock_scores.high_52w / low_52w AND market_fundamentals_global.
// Chunked and jittered to respect rate limits.
import { preflight, jsonResponse, errorResponse, svcClient, corsFor } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { getServiceProvider } from "../_shared/market/provider.ts";

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
    const { provider } = await getServiceProvider(svc);
    // Prioritize active NSE equities whose 52w row is missing or older than 7 days.
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data: stale } = await svc
      .from("market_stock_scores")
      .select("symbol,exchange,computed_at,high_52w,low_52w")
      .eq("exchange", "NSE")
      .or(`high_52w.is.null,computed_at.lt.${cutoff}`)
      .limit(CHUNK * 4);
    const work = (stale ?? []).slice(0, CHUNK).map((r: any) => ({
      symbol: r.symbol, exchange: r.exchange,
      prevHigh: r.high_52w == null ? null : Number(r.high_52w),
      prevLow: r.low_52w == null ? null : Number(r.low_52w),
    }));

    let updated = 0, failed = 0;
    const started = Date.now();

    const compute52w = async (symbol: string, exchange: string) => {
      try {
        const candles = await provider.getOHLCV(symbol, exchange, "1y", "1d");
        if (candles.length < 20) return null;
        let hi = -Infinity, lo = Infinity;
        for (const c of candles) {
          if (Number.isFinite(c.high) && c.high > hi) hi = c.high;
          if (Number.isFinite(c.low) && c.low > 0 && c.low < lo) lo = c.low;
        }
        if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
        return { high: hi, low: lo, asOf: Date.now() };
      } catch {
        return await fetchYahoo52w(symbol);
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const item = work.shift();
        if (!item) break;
        try {
          const res = await compute52w(item.symbol, item.exchange);
          if (!res) { failed++; await sleep(150); continue; }
          const { high, low } = res;
          // EGRESS: 52w extremes barely move day to day. Skipping the no-op
          // write removes two PostgREST round-trips per unchanged symbol.
          const same = item.prevHigh != null && item.prevLow != null
            && Math.abs(item.prevHigh - high) < 0.01 && Math.abs(item.prevLow - low) < 0.01;
          if (!same) {
            await Promise.all([
              svc.from("market_stock_scores").update({ high_52w: high, low_52w: low }).eq("symbol", item.symbol).eq("exchange", item.exchange),
              svc.from("market_fundamentals_global").update({ high_52w: high, low_52w: low, updated_at: new Date().toISOString() }).eq("symbol", item.symbol).eq("exchange", item.exchange),
            ]);
          }
          updated++;
        } catch { failed++; }
        await sleep(200 + Math.random() * 200);
      }
    });
    await Promise.all(workers);

    await svc.from("market_ingestion_runs").insert({
      source: "market_52w_refresh", stage: "fetch",
      status: failed > updated ? "partial" : "ok",
      rows_ingested: updated, duration_ms: Date.now() - started,
      metadata: { failed, attempted: updated + failed, provider: (provider as any).name ?? "unknown" },
      finished_at: new Date().toISOString(),
    });

    return jsonResponse(req, { ok: true, updated, failed, drained: (updated + failed) < CHUNK });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});