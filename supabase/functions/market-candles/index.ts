// market-candles — candles for the Analysis chart.
// 1D: cached in market_daily_prices (Kotak-first backfill via provider, Yahoo fallback).
// 15m/1h: intraday provider fetch, cached in market_intraday_prices (15-min staleness).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { yahooChartRetry, toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";

const INTRADAY: Record<string, { interval: string; range: string }> = {
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "30d" },
  "1h": { interval: "1h", range: "60d" },
};

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
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
      if (rows.length < 100) {
        // Backfill: prefer active provider (Kotak when connected), fall back to Yahoo.
        try {
          const { provider } = await getActiveProvider(svc, auth.userId);
          let candles;
          try {
            candles = await provider.getOHLCV(symbol, exchange, "2y", "1d");
          } catch {
            candles = await yahooChartRetry(toYahooSymbol(symbol, exchange), "2y", "1d");
          }
          const upserts = candles.map((c) => ({
            symbol, exchange,
            trade_date: new Date(c.time * 1000).toISOString().slice(0, 10),
            open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
          }));
          for (let i = 0; i < upserts.length; i += 500) {
            await svc.from("market_daily_prices").upsert(upserts.slice(i, i + 500), { onConflict: "symbol,exchange,trade_date" });
          }
          rows = upserts;
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

      return jsonResponse(req, { candles, emas, timeframe });
    }

    const cfg = INTRADAY[timeframe];
    if (!cfg) return errorResponse(req, `Unsupported timeframe: ${timeframe}`);

    // Intraday goes straight to the provider. The old market_intraday_prices
    // cache had no interval column, so 5m/15m/1h bars for the same symbol
    // collided in one (symbol,exchange,ts) keyspace and reads returned a mix.
    // The client already caches responses for 5 minutes (react-query staleTime).
    let raw;
    try {
      const { provider } = await getActiveProvider(svc, auth.userId);
      raw = await provider.getOHLCV(symbol, exchange, cfg.range, cfg.interval);
    } catch {
      raw = await yahooChartRetry(toYahooSymbol(symbol, exchange), cfg.range, cfg.interval);
    }
    const candles = raw.map((c) => ({
      time: c.time,
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume ?? 0,
    }));
    return jsonResponse(req, { candles, emas: {}, timeframe });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
