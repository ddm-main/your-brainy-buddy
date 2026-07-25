// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-news-sync — pulls Yahoo RSS headlines for a bounded symbol set
// (explicit list, or the caller's own watchlist+holdings) and upserts into
// market_news. Yahoo-only by design: Kotak Neo has no news feed, so there's
// no primary provider to fall back from. Deliberately not a full-universe
// cron: news for ~2700 stocks isn't useful for a personal app, only for
// symbols the user actually cares about.

import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { toYahooSymbol, yahooNews } from "../_shared/market/yahooClient.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const b = await req.json().catch(() => ({}));
    let symbols: Array<{ symbol: string; exchange: string }> = Array.isArray(b?.symbols)
      ? b.symbols.map((s: any) => ({ symbol: String(s.symbol ?? s).toUpperCase(), exchange: String(s.exchange ?? "NSE").toUpperCase() }))
      : [];

    if (symbols.length === 0) {
      const [watch, holdings] = await Promise.all([
        svc.from("market_watchlist_items").select("symbol,exchange").eq("user_id", auth.userId),
        svc.from("market_holdings").select("symbol,exchange").eq("user_id", auth.userId),
      ]);
      const seen = new Set<string>();
      for (const row of [...(watch.data ?? []), ...(holdings.data ?? [])]) {
        const key = `${row.exchange}:${row.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push({ symbol: row.symbol, exchange: row.exchange });
      }
    }
    symbols = symbols.slice(0, 40); // one RSS fetch per symbol — keep a single invocation bounded

    let upserted = 0;
    for (const { symbol, exchange } of symbols) {
      const items = await yahooNews(toYahooSymbol(symbol, exchange));
      if (items.length === 0) continue;
      const rows = items.slice(0, 15).map((it) => ({
        symbol, exchange,
        headline: it.headline,
        url: it.url,
        source: it.source,
        published_at: it.published_at,
      }));
      const { error } = await svc.from("market_news").upsert(rows, { onConflict: "symbol,exchange,url", ignoreDuplicates: true });
      if (!error) upserted += rows.length;
    }
    return jsonResponse(req, { ok: true, symbols: symbols.length, upserted });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
