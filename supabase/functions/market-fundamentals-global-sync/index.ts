// market-fundamentals-global-sync — chunked, resumable fundamentals sync.
// Fetches Yahoo quoteSummary first (with rename-map + Yahoo search fallback),
// merges NSE public metadata, derives PB/PEG/dividend_yield when Yahoo omits them,
// and records per-symbol sync status.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { requireUserId } from "../_shared/auth.ts";
import { toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { yahooQuoteSummary, yahooSearchSymbol } from "../_shared/market/yahooCrumb.ts";
import { nseEquityMeta } from "../_shared/market/nseClient.ts";

const CHUNK = 40;
const CONCURRENCY = 4;
const MODULES = "summaryDetail,defaultKeyStatistics,financialData,price,assetProfile,incomeStatementHistory,balanceSheetHistory,majorHoldersBreakdown";

// Known NSE ticker renames — try the new symbol before falling back to search.
const RENAME_MAP: Record<string, string> = {
  GMRINFRA: "GMRAIRPORT",
  ZOMATO: "ETERNAL",
  MINDTREE: "LTIM",
  LTI: "LTIM",
  SRTRANSFIN: "SHRIRAMFIN",
  SHRIRAMCIT: "SHRIRAMFIN",
  HDFC: "HDFCBANK",
};

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

    // Batch-load instrument types for the claimed chunk so we can compute
    // "no dividend => 0%" only for equities and skip that inference for ETFs/funds.
    const instrumentTypeBy = new Map<string, string>();
    if (work.length > 0) {
      const { data: types } = await svc.from("market_stocks")
        .select("symbol,exchange,instrument_type")
        .in("symbol", work.map((w: any) => w.symbol));
      (types ?? []).forEach((t: any) => {
        instrumentTypeBy.set(`${t.symbol}|${t.exchange}`, t.instrument_type || "EQ");
      });
    }

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const s = work.shift();
        if (!s) break;
        const now = new Date().toISOString();
        const instrumentType = instrumentTypeBy.get(`${s.symbol}|${s.exchange}`) || "EQ";
        try {
          // 1) Preferred symbol: stored → rename-map override → derived .NS
          const mapped = RENAME_MAP[s.symbol];
          const primary = s.yahoo_symbol
            || (mapped ? `${mapped}.NS` : null)
            || toYahooSymbol(s.symbol, s.exchange);

          let r: QSResult | null = null;
          let resolvedYahoo: string | null = null;
          try {
            r = await fetchOne(primary);
            if (r) resolvedYahoo = primary;
          } catch { /* handled by fallback */ }

          // 2) If Yahoo returned nothing, try search-based resolution once.
          if (!r) {
            const alt = await yahooSearchSymbol(mapped ?? s.symbol);
            if (alt && alt !== primary) {
              try {
                const r2 = await fetchOne(alt);
                if (r2) { r = r2; resolvedYahoo = alt; }
              } catch { /* fall through */ }
            }
          }

          const nse = await nseEquityMeta(s.symbol).catch(() => null);

          const marketCapCr = num(
            r?.price?.marketCap?.raw != null ? r.price.marketCap.raw / 1e7 : null,
            nse?.marketCapCr,
          );
          const revenueCr = r?.financialData?.totalRevenue?.raw != null ? r.financialData.totalRevenue.raw / 1e7 : null;
          const netIncome = r?.incomeStatementHistory?.incomeStatementHistory?.[0]?.netIncome?.raw;
          const profitCr = netIncome != null ? netIncome / 1e7 : null;
          const roeRaw = r?.financialData?.returnOnEquity?.raw;
          const roeMaybePct = roeRaw != null ? (Math.abs(roeRaw) <= 5 ? roeRaw * 100 : roeRaw) : null;

          const price = num(r?.financialData?.currentPrice?.raw, r?.price?.regularMarketPrice?.raw, nse?.price);
          const bookValue = num(r?.defaultKeyStatistics?.bookValue?.raw);
          const eps = num(r?.defaultKeyStatistics?.trailingEps?.raw);
          const pe = num(r?.summaryDetail?.trailingPE?.raw, nse?.pe);
          let pb: number | null = num(r?.defaultKeyStatistics?.priceToBook?.raw, r?.summaryDetail?.priceToBook?.raw, nse?.pb);
          // Derived PB when both sides missing but price+book present.
          if (pb == null && price != null && bookValue != null && bookValue > 0) pb = price / bookValue;

          const epsGrowth = r?.defaultKeyStatistics?.earningsQuarterlyGrowth?.raw != null ? r.defaultKeyStatistics.earningsQuarterlyGrowth.raw * 100 : null;
          const revGrowth = r?.financialData?.revenueGrowth?.raw != null ? r.financialData.revenueGrowth.raw * 100 : null;
          const earnGrowth = r?.financialData?.earningsGrowth?.raw != null ? r.financialData.earningsGrowth.raw * 100 : null;
          let peg: number | null = num(r?.defaultKeyStatistics?.pegRatio?.raw);
          if (peg == null && pe != null) {
            const g = [epsGrowth, earnGrowth, revGrowth].find((x) => x != null && x > 0) ?? null;
            if (g != null) peg = pe / g;
          }

          // Dividend yield: Yahoo returns null for zero-dividend stocks. For
          // equities where price and no dividend were returned, treat as 0%.
          let dy: number | null = r?.summaryDetail?.dividendYield?.raw != null ? r.summaryDetail.dividendYield.raw * 100 : null;
          if (dy == null && instrumentType === "EQ" && r != null && price != null) dy = 0;

          // ROCE proxy from Yahoo returnOnAssets when true ROCE not reported.
          const roa = r?.financialData?.returnOnAssets?.raw as number | undefined;
          const roce = roa != null ? (Math.abs(roa) <= 5 ? roa * 100 : roa) : null;

          // Sector fallback: for ETFs/funds label passively; keeps the Sector
          // chip honest instead of counting them as gaps.
          let sectorFinal = str(nse?.sector, r?.assetProfile?.sector);
          let industryFinal = str(nse?.industry, r?.assetProfile?.industry);
          if (!sectorFinal && instrumentType !== "EQ") {
            sectorFinal = "ETF / Index Fund";
            industryFinal = industryFinal ?? "Passive Fund";
          }

          const row = {
            symbol: s.symbol,
            exchange: s.exchange,
            company_name: str(r?.assetProfile?.longName, nse?.companyName, s.company_name),
            sector: sectorFinal,
            industry: industryFinal,
            market_cap_cr: marketCapCr,
            price,
            pe_ttm: pe,
            pb,
            peg,
            eps_ttm: eps,
            dividend_yield: dy,
            book_value: bookValue,
            roe: roeMaybePct,
            roce,
            debt_to_equity: num(r?.financialData?.debtToEquity?.raw),
            current_ratio: num(r?.financialData?.currentRatio?.raw),
            quick_ratio: num(r?.financialData?.quickRatio?.raw),
            revenue_ttm_cr: revenueCr,
            profit_ttm_cr: profitCr,
            revenue_growth_yoy: revGrowth,
            profit_growth_yoy: earnGrowth,
            eps_growth_yoy: epsGrowth,
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
          // Core-5 completeness promotion: if sector + mcap + (pe|eps) + price
          // are all present, the row is complete regardless of the useful count.
          // This drains legacy `partial` rows automatically once the missing
          // sector/mcap arrives on a later run.
          const coreComplete = row.sector != null
            && row.market_cap_cr != null
            && (row.pe_ttm != null || row.eps_ttm != null)
            && row.price != null;
          const threshold = instrumentType === "EQ" ? 4 : 2;
          const status: "ok" | "partial" = coreComplete || useful >= threshold ? "ok" : "partial";
          await svc.from("market_fundamentals_global").upsert({
            ...row,
            sync_status: status,
            last_error: status === "partial" ? "partial upstream coverage" : null,
          }, { onConflict: "symbol,exchange" });
          const stocksUpdate: Record<string, unknown> = {};
          if (marketCapCr != null) stocksUpdate.market_cap = marketCapCr;
          if (row.sector) stocksUpdate.sector = row.sector;
          if (row.industry) stocksUpdate.industry = row.industry;
          if (resolvedYahoo && resolvedYahoo !== s.yahoo_symbol) stocksUpdate.yahoo_symbol = resolvedYahoo;
          if (Object.keys(stocksUpdate).length > 0) {
            await svc.from("market_stocks").update(stocksUpdate)
              .eq("symbol", s.symbol).eq("exchange", s.exchange);
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
