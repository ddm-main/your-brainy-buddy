// market-fundamentals-global-sync — chunked, resumable fundamentals sync.
// Each invocation consumes up to CHUNK stocks whose cursor is stale
// (last_fundamentals_sync_at is null OR older than 7 days), fetches Yahoo
// quoteSummary in parallel, upserts market_fundamentals_global, and backfills
// market_stocks.market_cap/sector/industry. The cursor is always stamped so a
// bad symbol can't wedge the pipeline. Call repeatedly until drained.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { requireUserId } from "../_shared/auth.ts";
import { toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { safeFetch } from "../_shared/http.ts";

const CHUNK = 40;
const CONCURRENCY = 4;
const STALE_INTERVAL = "7 days";
const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const MODULES = "summaryDetail,defaultKeyStatistics,financialData,price,assetProfile,incomeStatementHistory,balanceSheetHistory,majorHoldersBreakdown";

interface QSResult {
  summaryDetail?: {
    trailingPE?: { raw: number };
    priceToBook?: { raw: number };
    dividendYield?: { raw: number };
    fiftyTwoWeekHigh?: { raw: number };
    fiftyTwoWeekLow?: { raw: number };
  };
  defaultKeyStatistics?: {
    trailingEps?: { raw: number };
    priceToBook?: { raw: number };
    pegRatio?: { raw: number };
    bookValue?: { raw: number };
    earningsQuarterlyGrowth?: { raw: number };
    heldPercentInsiders?: { raw: number };
    heldPercentInstitutions?: { raw: number };
  };
  financialData?: {
    returnOnEquity?: { raw: number };
    returnOnAssets?: { raw: number };
    debtToEquity?: { raw: number };
    currentRatio?: { raw: number };
    quickRatio?: { raw: number };
    totalRevenue?: { raw: number };
    revenueGrowth?: { raw: number };
    earningsGrowth?: { raw: number };
    profitMargins?: { raw: number };
    operatingMargins?: { raw: number };
    currentPrice?: { raw: number };
  };
  price?: { marketCap?: { raw: number }; regularMarketPrice?: { raw: number } };
  assetProfile?: { sector?: string; industry?: string; longName?: string };
  incomeStatementHistory?: { incomeStatementHistory?: Array<{ netIncome?: { raw: number } }> };
}

async function fetchOne(symbol: string): Promise<QSResult | null> {
  const path = `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${MODULES}`;
  for (const host of HOSTS) {
    const r = await safeFetch(`https://${host}${path}`, {
      timeoutMs: 6000, maxBytes: 512 * 1024, allowHosts: HOSTS,
      headers: { "User-Agent": "Mozilla/5.0 (Jarvis global-fundamentals-sync)" },
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
  // Auth: cron secret OR signed-in user (for manual triggers from the UI).
  if (req.headers.get("x-cron-secret") != null) {
    const guard = requireCronSecret(req);
    if (guard) return guard;
  } else {
    const auth = await requireUserId(req);
    if ("error" in auth) return auth.error;
  }

  try {
    const svc = svcClient();
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    // Pick the next chunk of stale/never-synced stocks.
    const { data: stocks, error } = await svc.from("market_stocks")
      .select("symbol,exchange,company_name")
      .eq("is_active", true)
      .eq("in_universe", true)
      .or(`last_fundamentals_sync_at.is.null,last_fundamentals_sync_at.lt.${cutoff}`)
      .order("last_fundamentals_sync_at", { ascending: true, nullsFirst: true })
      .limit(CHUNK);
    if (error) return errorResponse(req, error.message, 500);

    if (!stocks || stocks.length === 0) {
      return jsonResponse(req, { ok: true, processed: 0, synced: 0, failed: 0, drained: true });
    }

    let synced = 0;
    let failed = 0;
    const work = [...stocks];

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const s = work.shift();
        if (!s) break;
        let ok = false;
        try {
          const yq = toYahooSymbol(s.symbol, s.exchange);
          const r = await fetchOne(yq);
          if (r) {
            const marketCapCr = r.price?.marketCap?.raw != null ? r.price.marketCap.raw / 1e7 : null;
            const revenueCr   = r.financialData?.totalRevenue?.raw != null ? r.financialData.totalRevenue.raw / 1e7 : null;
            const netIncome   = r.incomeStatementHistory?.incomeStatementHistory?.[0]?.netIncome?.raw;
            const profitCr    = netIncome != null ? netIncome / 1e7 : null;
            const roeRaw      = r.financialData?.returnOnEquity?.raw;
            const roeMaybePct = roeRaw != null ? (Math.abs(roeRaw) <= 5 ? roeRaw * 100 : roeRaw) : null;
            const row = {
              symbol: s.symbol,
              exchange: s.exchange,
              company_name: r.assetProfile?.longName ?? s.company_name ?? null,
              sector: r.assetProfile?.sector ?? null,
              industry: r.assetProfile?.industry ?? null,
              market_cap_cr: marketCapCr,
              price: r.financialData?.currentPrice?.raw ?? r.price?.regularMarketPrice?.raw ?? null,
              pe_ttm: r.summaryDetail?.trailingPE?.raw ?? null,
              pb: r.defaultKeyStatistics?.priceToBook?.raw ?? r.summaryDetail?.priceToBook?.raw ?? null,
              peg: r.defaultKeyStatistics?.pegRatio?.raw ?? null,
              eps_ttm: r.defaultKeyStatistics?.trailingEps?.raw ?? null,
              dividend_yield: r.summaryDetail?.dividendYield?.raw != null ? r.summaryDetail.dividendYield.raw * 100 : null,
              book_value: r.defaultKeyStatistics?.bookValue?.raw ?? null,
              roe: roeMaybePct,
              roce: null,
              debt_to_equity: r.financialData?.debtToEquity?.raw ?? null,
              current_ratio: r.financialData?.currentRatio?.raw ?? null,
              quick_ratio: r.financialData?.quickRatio?.raw ?? null,
              revenue_ttm_cr: revenueCr,
              profit_ttm_cr: profitCr,
              revenue_growth_yoy: r.financialData?.revenueGrowth?.raw != null ? r.financialData.revenueGrowth.raw * 100 : null,
              profit_growth_yoy: r.financialData?.earningsGrowth?.raw != null ? r.financialData.earningsGrowth.raw * 100 : null,
              eps_growth_yoy: r.defaultKeyStatistics?.earningsQuarterlyGrowth?.raw != null ? r.defaultKeyStatistics.earningsQuarterlyGrowth.raw * 100 : null,
              promoter_holding: r.defaultKeyStatistics?.heldPercentInsiders?.raw != null ? r.defaultKeyStatistics.heldPercentInsiders.raw * 100 : null,
              promoter_pledge: null,
              fii_holding: null,
              dii_holding: r.defaultKeyStatistics?.heldPercentInstitutions?.raw != null ? r.defaultKeyStatistics.heldPercentInstitutions.raw * 100 : null,
              face_value: null,
              high_52w: r.summaryDetail?.fiftyTwoWeekHigh?.raw ?? null,
              low_52w: r.summaryDetail?.fiftyTwoWeekLow?.raw ?? null,
              updated_at: new Date().toISOString(),
            };
            await svc.from("market_fundamentals_global").upsert(row, { onConflict: "symbol,exchange" });
            if (marketCapCr != null || row.sector || row.industry) {
              await svc.from("market_stocks").update({
                ...(marketCapCr != null ? { market_cap: marketCapCr } : {}),
                ...(row.sector ? { sector: row.sector } : {}),
                ...(row.industry ? { industry: row.industry } : {}),
              }).eq("symbol", s.symbol).eq("exchange", s.exchange);
            }
            ok = true;
          }
        } catch { /* swallow, stamp cursor anyway */ }
        // Always stamp cursor so bad symbols cycle to the back.
        await svc.from("market_stocks")
          .update({ last_fundamentals_sync_at: new Date().toISOString() })
          .eq("symbol", s.symbol).eq("exchange", s.exchange);
        if (ok) synced++; else failed++;
      }
    });
    await Promise.all(workers);

    // Total remaining stale rows so the UI can render progress.
    const { count: remaining } = await svc.from("market_stocks")
      .select("symbol", { count: "exact", head: true })
      .eq("is_active", true).eq("in_universe", true)
      .or(`last_fundamentals_sync_at.is.null,last_fundamentals_sync_at.lt.${cutoff}`);

    return jsonResponse(req, {
      ok: true,
      processed: stocks.length,
      synced,
      failed,
      remaining: remaining ?? 0,
      drained: stocks.length < CHUNK,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
