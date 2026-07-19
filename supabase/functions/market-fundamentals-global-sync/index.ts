// market-fundamentals-global-sync — chunked, resumable fundamentals sync.
// Uses all active universe stocks from market_fundamentals_sync_queue, fetches
// Yahoo quoteSummary first, falls back to NSE public metadata, and records
// per-symbol sync status instead of silently hiding failures.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { requireUserId } from "../_shared/auth.ts";
import { toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { yahooQuoteSummary } from "../_shared/market/yahooCrumb.ts";
import { nseEquityMeta } from "../_shared/market/nseClient.ts";

const CHUNK = 40;
const CONCURRENCY = 4;
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
  // Crumb-authenticated quoteSummary — anonymous v10 calls now 401.
  return (await yahooQuoteSummary(symbol, MODULES)) as QSResult | null;
}

const num = (...values: unknown[]): number | null => {
  for (const v of values) {
    if (v == null || v === "") continue;
    const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const str = (...values: unknown[]): string | null => {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

function usefulFieldCount(row: Record<string, unknown>): number {
  return [
    row.market_cap_cr,
    row.price,
    row.pe_ttm,
    row.pb,
    row.roe,
    row.debt_to_equity,
    row.revenue_ttm_cr,
    row.profit_ttm_cr,
    row.high_52w,
    row.low_52w,
    row.sector,
    row.industry,
  ].filter((v) => v !== null && v !== undefined && v !== "").length;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  // Auth: cron secret OR signed-in user (for manual triggers from the UI).
  if (req.headers.get("x-cron-secret") != null) {
    const guard = await requireCronSecret(req);
    if (guard) return guard;
  } else {
    const auth = await requireUserId(req);
    if ("error" in auth) return auth.error;
  }

  try {
    const svc = svcClient();
    // Atomically claim the next chunk so overlapping cron/manual runs never
    // process the same 40 symbols. The RPC stamps the cursor immediately.
    const { data: stocks, error } = await svc.rpc("claim_market_fundamentals_sync", { _limit: CHUNK });
    if (error) return errorResponse(req, error.message, 500);

    if (!stocks || stocks.length === 0) {
      return jsonResponse(req, { ok: true, processed: 0, synced: 0, failed: 0, drained: true });
    }

    let synced = 0;
    let partial = 0;
    let failed = 0;
    const work = [...stocks];

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const s = work.shift();
        if (!s) break;
        const now = new Date().toISOString();
        try {
          const yq = s.yahoo_symbol || toYahooSymbol(s.symbol, s.exchange);
          const [r, nse] = await Promise.allSettled([fetchOne(yq), nseEquityMeta(s.symbol)]).then((results) => [
            results[0].status === "fulfilled" ? results[0].value : null,
            results[1].status === "fulfilled" ? results[1].value : null,
          ] as const);

          const marketCapCr = num(
            r?.price?.marketCap?.raw != null ? r.price.marketCap.raw / 1e7 : null,
            nse?.marketCapCr,
          );
          const revenueCr = r?.financialData?.totalRevenue?.raw != null ? r.financialData.totalRevenue.raw / 1e7 : null;
          const netIncome = r?.incomeStatementHistory?.incomeStatementHistory?.[0]?.netIncome?.raw;
          const profitCr = netIncome != null ? netIncome / 1e7 : null;
          const roeRaw = r?.financialData?.returnOnEquity?.raw;
          const roeMaybePct = roeRaw != null ? (Math.abs(roeRaw) <= 5 ? roeRaw * 100 : roeRaw) : null;
          const row = {
            symbol: s.symbol,
            exchange: s.exchange,
            company_name: str(r?.assetProfile?.longName, nse?.companyName, s.company_name),
            sector: str(nse?.sector, r?.assetProfile?.sector),
            industry: str(nse?.industry, r?.assetProfile?.industry),
            market_cap_cr: marketCapCr,
            price: num(r?.financialData?.currentPrice?.raw, r?.price?.regularMarketPrice?.raw, nse?.price),
            pe_ttm: num(r?.summaryDetail?.trailingPE?.raw, nse?.pe),
            pb: num(r?.defaultKeyStatistics?.priceToBook?.raw, r?.summaryDetail?.priceToBook?.raw, nse?.pb),
            peg: num(r?.defaultKeyStatistics?.pegRatio?.raw),
            eps_ttm: num(r?.defaultKeyStatistics?.trailingEps?.raw),
            dividend_yield: r?.summaryDetail?.dividendYield?.raw != null ? r.summaryDetail.dividendYield.raw * 100 : null,
            book_value: num(r?.defaultKeyStatistics?.bookValue?.raw),
            roe: roeMaybePct,
            roce: null,
            debt_to_equity: num(r?.financialData?.debtToEquity?.raw),
            current_ratio: num(r?.financialData?.currentRatio?.raw),
            quick_ratio: num(r?.financialData?.quickRatio?.raw),
            revenue_ttm_cr: revenueCr,
            profit_ttm_cr: profitCr,
            revenue_growth_yoy: r?.financialData?.revenueGrowth?.raw != null ? r.financialData.revenueGrowth.raw * 100 : null,
            profit_growth_yoy: r?.financialData?.earningsGrowth?.raw != null ? r.financialData.earningsGrowth.raw * 100 : null,
            eps_growth_yoy: r?.defaultKeyStatistics?.earningsQuarterlyGrowth?.raw != null ? r.defaultKeyStatistics.earningsQuarterlyGrowth.raw * 100 : null,
            promoter_holding: r?.defaultKeyStatistics?.heldPercentInsiders?.raw != null ? r.defaultKeyStatistics.heldPercentInsiders.raw * 100 : null,
            promoter_pledge: null,
            fii_holding: null,
            dii_holding: r?.defaultKeyStatistics?.heldPercentInstitutions?.raw != null ? r.defaultKeyStatistics.heldPercentInstitutions.raw * 100 : null,
            face_value: null,
            high_52w: num(r?.summaryDetail?.fiftyTwoWeekHigh?.raw, nse?.high52w),
            low_52w: num(r?.summaryDetail?.fiftyTwoWeekLow?.raw, nse?.low52w),
            sync_source: r && nse ? "yahoo+nse" : r ? "yahoo" : nse ? "nse" : null,
            last_attempted_at: now,
            data_as_of: now,
            updated_at: now,
          };
          const useful = usefulFieldCount(row);
          if (useful === 0) {
            throw new Error("no usable fundamentals returned from Yahoo or NSE");
          }
          const status = useful >= 4 ? "ok" : "partial";
          await svc.from("market_fundamentals_global").upsert({
            ...row,
            sync_status: status,
            last_error: status === "partial" ? "partial upstream coverage" : null,
          }, { onConflict: "symbol,exchange" });
          if (marketCapCr != null || row.sector || row.industry) {
            await svc.from("market_stocks").update({
              ...(marketCapCr != null ? { market_cap: marketCapCr } : {}),
              ...(row.sector ? { sector: row.sector } : {}),
              ...(row.industry ? { industry: row.industry } : {}),
            }).eq("symbol", s.symbol).eq("exchange", s.exchange);
          }
          if (status === "ok") synced++; else partial++;
        } catch (err) {
          failed++;
          const message = err instanceof Error ? err.message : String(err);
          await svc.from("market_fundamentals_global").upsert({
            symbol: s.symbol,
            exchange: s.exchange,
            company_name: s.company_name ?? null,
            sync_status: "failed",
            sync_source: null,
            last_error: message.slice(0, 500),
            last_attempted_at: now,
            updated_at: now,
          }, { onConflict: "symbol,exchange" });
        }
      }
    });
    await Promise.all(workers);

    // Total remaining stale rows so the UI can render progress.
    const { count: remaining } = await svc.from("market_fundamentals_sync_queue")
      .select("symbol", { count: "exact", head: true })
      .neq("symbol", "");

    return jsonResponse(req, {
      ok: true,
      processed: stocks.length,
      synced,
      partial,
      failed,
      remaining: remaining ?? 0,
      drained: (remaining ?? 0) === 0,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
