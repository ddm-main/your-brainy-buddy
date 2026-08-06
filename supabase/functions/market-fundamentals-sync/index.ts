// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-fundamentals-sync — nightly cron. Pulls Yahoo quoteSummary for every
// active in-universe stock (paged) and upserts typed columns into market_fundamentals.
// Yahoo-only: Kotak Neo doesn't expose fundamentals; nothing to prefer.

import { preflight, jsonResponse, errorResponse, svcClient, SHARED_CACHE_USER_ID } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { safeFetch } from "../_shared/http.ts";

const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const MODULES = "summaryDetail,defaultKeyStatistics,financialData,price,assetProfile";

interface QSResult {
  summaryDetail?: { trailingPE?: { raw: number }; priceToBook?: { raw: number }; dividendYield?: { raw: number } };
  defaultKeyStatistics?: { trailingEps?: { raw: number }; priceToBook?: { raw: number } };
  financialData?: { returnOnEquity?: { raw: number }; debtToEquity?: { raw: number }; returnOnAssets?: { raw: number } };
  price?: { marketCap?: { raw: number } };
  assetProfile?: { sector?: string; industry?: string };
}

async function fetchOne(symbol: string): Promise<QSResult | null> {
  const path = `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${MODULES}`;
  for (const host of HOSTS) {
    const r = await safeFetch(`https://${host}${path}`, {
      timeoutMs: 8000, maxBytes: 512 * 1024, allowHosts: HOSTS,
      headers: { "User-Agent": "Mozilla/5.0 (Jarvis fundamentals-sync)" },
    });
    if (!r.ok) continue;
    try {
      const j = JSON.parse(new TextDecoder().decode(r.bytes));
      const result = j?.quoteSummary?.result?.[0];
      if (result) return result as QSResult;
    } catch { /* try next host */ }
  }
  return null;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = await requireCronSecret(req); if (gate) return gate;
  try {
    const svc = svcClient();
    const PAGE = 500;
    let from = 0;
    let synced = 0, failed = 0, seen = 0;
    // Time-box to avoid runaway invocations; cron re-runs pick up remaining rows next night.
    const startedAt = Date.now();
    const MAX_MS = 12 * 60 * 1000; // 12 minutes

    for (;;) {
      const { data: stocks, error } = await svc.from("market_stocks")
        .select("symbol,exchange")
        .eq("is_active", true)
        .eq("in_universe", true)
        // Penny names are gated at the DB anyway; skipping them here saves the
        // provider round-trips instead of throwing the rows away on write.
        .not("penny_excluded", "is", true)
        .order("symbol", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return errorResponse(req, error.message, 500);
      if (!stocks || stocks.length === 0) break;
      seen += stocks.length;

      for (const s of stocks) {
        if (Date.now() - startedAt > MAX_MS) {
          return jsonResponse(req, { ok: true, synced, failed, seen, timed_out: true });
        }
        try {
          const yq = toYahooSymbol(s.symbol, s.exchange);
          const r = await fetchOne(yq);
          if (!r) { failed++; continue; }
          const row = {
            user_id: SHARED_CACHE_USER_ID, // shared cache
            symbol: s.symbol,
            exchange: s.exchange,
            pe: r.summaryDetail?.trailingPE?.raw ?? null,
            pb: r.defaultKeyStatistics?.priceToBook?.raw ?? r.summaryDetail?.priceToBook?.raw ?? null,
            roe: r.financialData?.returnOnEquity?.raw != null ? r.financialData.returnOnEquity.raw * 100 : null,
            roce: null,
            debt_to_equity: r.financialData?.debtToEquity?.raw ?? null,
            market_cap_cr: r.price?.marketCap?.raw != null ? r.price.marketCap.raw / 1e7 : null,
            dividend_yield: r.summaryDetail?.dividendYield?.raw != null ? r.summaryDetail.dividendYield.raw * 100 : null,
            eps_ttm: r.defaultKeyStatistics?.trailingEps?.raw ?? null,
            sector: r.assetProfile?.sector ?? null,
            industry: r.assetProfile?.industry ?? null,
            payload: r as unknown as Record<string, unknown>,
            fetched_at: new Date().toISOString(),
          };
          await svc.from("market_fundamentals").upsert(row, { onConflict: "user_id,symbol,exchange" });
          synced++;
          await new Promise((r) => setTimeout(r, 250)); // throttle
        } catch { failed++; }
      }

      if (stocks.length < PAGE) break;
      from += PAGE;
    }
    return jsonResponse(req, { ok: true, synced, failed, seen });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
