// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-news-sync — pulls headlines for a bounded symbol set (explicit
// list, or the caller's own watchlist+holdings) and upserts into
// market_news. Source is Google News RSS: Yahoo's per-symbol RSS feed is
// empty for NSE tickers and its search endpoint returns unrelated US wire
// copy. Deliberately not a full-universe cron: news for ~2700 stocks isn't
// useful for a personal app, only for symbols the user actually cares about.

import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { fetchStockNews } from "../_shared/market/yahooClient.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { lowBandwidthMode } from "../_shared/market/cron.ts";


Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  // Two callers: the UI (user JWT, syncs that user's symbols) and pg_cron
  // (x-cron-secret, no user). The cron path used to fall through to
  // requireUserId and 401 on every single scheduled run — which is why the
  // scheduled news job "succeeded" for months without ever writing a row.
  const isCron = req.headers.has("x-cron-secret");
  let userId: string | null = null;
  if (isCron) {
    const denied = await requireCronSecret(req);
    if (denied) return denied;
  } else {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
    userId = auth.userId;
  }
  try {
    const svc = svcClient();
    // Free-plan brake: skip non-essential syncs when a quota meter is hot.
    if (await lowBandwidthMode(svc)) return jsonResponse(req, { ok: true, skipped: "low_bandwidth" });
    const b = await req.json().catch(() => ({}));
    let symbols: Array<{ symbol: string; exchange: string }> = Array.isArray(b?.symbols)
      ? b.symbols.map((s: any) => ({ symbol: String(s.symbol ?? s).toUpperCase(), exchange: String(s.exchange ?? "NSE").toUpperCase() }))
      : [];

    if (symbols.length === 0) {
      // Cron has no user: cover every symbol anyone watches or holds.
      const watchQ = svc.from("market_watchlist_items").select("symbol,exchange");
      const holdQ = svc.from("market_holdings").select("symbol,exchange");
      const [watch, holdings] = await Promise.all([
        userId ? watchQ.eq("user_id", userId) : watchQ,
        userId ? holdQ.eq("user_id", userId) : holdQ,
      ]);
      const seen = new Set<string>();
      for (const row of [...(watch.data ?? []), ...(holdings.data ?? [])]) {
        const key = `${row.exchange}:${row.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push({ symbol: row.symbol, exchange: row.exchange });
      }
    }
    symbols = symbols.slice(0, 40); // one feed fetch per symbol — keep a single invocation bounded

    // Company names make the news query far more accurate than the raw
    // ticker ("SANGHVIMOV" matches nothing; "Sanghvi Movers" does).
    const names = new Map<string, string>();
    if (symbols.length > 0) {
      const { data: stockRows } = await svc.from("market_stocks")
        .select("symbol,exchange,company_name")
        .in("symbol", symbols.map((s) => s.symbol));
      for (const r of stockRows ?? []) {
        if (r.company_name) names.set(`${r.exchange}:${r.symbol}`, r.company_name);
      }
    }

    let upserted = 0;
    let fetched = 0;
    const errors: string[] = [];
    for (const { symbol, exchange } of symbols) {
      const { items, error: fetchErr } = await fetchStockNews(symbol, names.get(`${exchange}:${symbol}`));
      if (fetchErr) { errors.push(`${exchange}:${symbol}: ${fetchErr}`); continue; }
      fetched += items.length;
      if (items.length === 0) continue;
      const rows = items.slice(0, 15).map((it) => ({
        symbol, exchange,
        headline: it.headline,
        url: it.url,
        source: it.source,
        published_at: it.published_at,
      }));
      const { error } = await svc.from("market_news").upsert(rows, { onConflict: "symbol,exchange,url", ignoreDuplicates: true });
      // Never report ok for a write that failed — this function used to
      // swallow the error and still return `ok: true`, which is why a broken
      // market_news schema went unnoticed while the table stayed empty.
      if (error) errors.push(`${exchange}:${symbol}: ${error.message}`);
      else upserted += rows.length;
    }
    if (errors.length > 0 && upserted === 0) {
      return errorResponse(req, `news sync failed — ${errors[0]}`, 502);
    }
    return jsonResponse(req, { ok: true, symbols: symbols.length, fetched, upserted, synced_at: new Date().toISOString(), errors: errors.length ? errors : undefined });


  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
