// market-candles — candles for the Analysis chart.
// 1D: cached in market_daily_prices (Kotak-first backfill via provider, Yahoo fallback).
// 15m/1h: intraday provider fetch, cached in market_intraday_prices (15-min staleness).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { yahooChartRetry, toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { getReadProvider } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";

const limiter = createMarketLimiter(120, 60_000);

const INTRADAY: Record<string, { interval: string; range: string }> = {
  "1m": { interval: "1m", range: "7d" },
  "3m": { interval: "2m", range: "7d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "30d" },
  "30m": { interval: "30m", range: "30d" },
  "1h": { interval: "60m", range: "60d" },
  "2h": { interval: "60m", range: "60d" },
  "4h": { interval: "60m", range: "60d" },
  "1W": { interval: "1wk", range: "5y" },
  "1M": { interval: "1mo", range: "10y" },
};

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;
  try {
    const b = await req.json().catch(() => ({}));
    const symbol = String(b?.symbol ?? "").toUpperCase();
    const exchange = String(b?.exchange ?? "NSE").toUpperCase();
    const timeframe = String(b?.timeframe ?? "1D");
    if (!symbol) return errorResponse(req, "symbol required");
    const svc = svcClient();

    if (timeframe === "1D") {
      const { data } = await svc.from("market_daily_prices")
        .select("trade_date,open,high,low,close,volume")
        .eq("symbol", symbol).eq("exchange", exchange)
        .order("trade_date", { ascending: true })
        .limit(600);
      let rows = data ?? [];
      // Most recent expected trading day (IST, Mon–Fri; use 16:00 IST cutoff).
      const nowUtc = new Date();
      const ist = new Date(nowUtc.getTime() + 5.5 * 3600_000);
      const expected = new Date(ist);
      if (ist.getUTCHours() < 16) expected.setUTCDate(expected.getUTCDate() - 1);
      while (expected.getUTCDay() === 0 || expected.getUTCDay() === 6) {
        expected.setUTCDate(expected.getUTCDate() - 1);
      }
      const expectedStr = expected.toISOString().slice(0, 10);
      const latestCached = rows.length ? String((rows[rows.length - 1] as any).trade_date).slice(0, 10) : "";
      const stale = latestCached < expectedStr;
      let providerName: "kotak_neo" | "yahoo" = "yahoo";
      if (rows.length < 100 || stale) {
        const range = rows.length < 100 ? "2y" : "30d";
        try {
          const { provider } = await getReadProvider(svc, auth.userId);
          let candles;
          try {
            candles = await provider.getOHLCV(symbol, exchange, range, "1d");
            providerName = provider.name === "kotak_neo" ? "kotak_neo" : "yahoo";
          } catch {
            candles = await yahooChartRetry(toYahooSymbol(symbol, exchange), range, "1d");
            providerName = "yahoo";
          }
          const upserts = candles.map((c) => ({
            symbol, exchange,
            trade_date: new Date(c.time * 1000).toISOString().slice(0, 10),
            open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
          }));
          for (let i = 0; i < upserts.length; i += 500) {
            await svc.from("market_daily_prices").upsert(upserts.slice(i, i + 500), { onConflict: "symbol,exchange,trade_date" });
          }
          if (rows.length < 100) {
            rows = upserts;
          } else {
            const byDate = new Map<string, any>();
            for (const r of rows) byDate.set(String((r as any).trade_date).slice(0, 10), r);
            for (const u of upserts) byDate.set(u.trade_date, u);
            rows = [...byDate.values()].sort((a: any, b: any) =>
              String(a.trade_date).localeCompare(String(b.trade_date)),
            );
          }
        } catch (e) {
          if (rows.length === 0) throw e;
        }
      }
      const candles = rows.map((r: any) => ({
        time: typeof r.trade_date === "string" ? r.trade_date : new Date(r.trade_date).toISOString().slice(0, 10),
        open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
        volume: Number(r.volume ?? 0),
      }));

      // EMA overlays from cache
      const { data: overlays } = await svc.from("market_indicators_cache")
        .select("indicator,value")
        .eq("symbol", symbol).eq("exchange", exchange).eq("timeframe", "1D")
        .in("indicator", ["ema20", "ema50", "ema200"]);
      const emas: Record<string, Array<{ t: number; v: number | null }>> = {};
      for (const o of overlays ?? []) emas[o.indicator] = o.value;

      return jsonResponse(req, { candles, emas, timeframe, provider: providerName });
    }

    const cfg = INTRADAY[timeframe];
    if (!cfg) return errorResponse(req, `Unsupported timeframe: ${timeframe}`);

    // Intraday goes straight to the provider. The old market_intraday_prices
    // cache had no interval column, so 5m/15m/1h bars for the same symbol
    // collided in one (symbol,exchange,ts) keyspace and reads returned a mix.
    // The client already caches responses for 5 minutes (react-query staleTime).
    let raw;
    let providerName: "kotak_neo" | "yahoo" = "yahoo";
    try {
      const { provider } = await getReadProvider(svc, auth.userId);
      raw = await provider.getOHLCV(symbol, exchange, cfg.range, cfg.interval);
      providerName = provider.name === "kotak_neo" ? "kotak_neo" : "yahoo";
    } catch {
      raw = await yahooChartRetry(toYahooSymbol(symbol, exchange), cfg.range, cfg.interval);
      providerName = "yahoo";
    }
    const candles = raw.map((c) => ({
      time: c.time,
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume ?? 0,
    }));
    return jsonResponse(req, { candles, emas: {}, timeframe, provider: providerName });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
