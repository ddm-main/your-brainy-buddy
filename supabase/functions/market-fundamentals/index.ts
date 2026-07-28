// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-fundamentals — per-symbol company fundamentals via Yahoo quoteSummary.
// Cached in market_fundamentals for 24h per user.
// Yahoo-only: Kotak Neo returns quotes / depth / holdings / orders, not
// P&L, balance sheet, ratios or ownership — so there's no broker-first path.

import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { yahooQuoteSummary } from "../_shared/market/yahooCrumb.ts";

const MODULES = [
  "summaryDetail",
  "defaultKeyStatistics",
  "financialData",
  "assetProfile",
  "incomeStatementHistory",
  "earnings",
  "calendarEvents",
  "price",
].join(",");

// Unit contract for this payload (the whole app depends on it):
//   • roe / roa / roce / margins / growth / dividend_yield  → DECIMAL fractions
//     (0.1503 = 15.03%). The UI multiplies by 100 exactly once.
//   • debt_to_equity                                        → a RATIO (0.51),
//     not Yahoo's percent form (51.4).
//   • promoter/fii/dii holding + pledge                     → PERCENT (0–100),
//     because that is how every Indian source publishes them.
type Fundamentals = {
  symbol: string;
  exchange: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  market_cap: number | null;
  pe_ttm: number | null;
  pe_forward: number | null;
  peg: number | null;
  eps_ttm: number | null;
  eps_forward: number | null;
  book_value: number | null;
  price_to_book: number | null;
  dividend_yield: number | null;
  roe: number | null;
  roce: number | null;
  roa: number | null;
  profit_margin: number | null;
  operating_margin: number | null;
  debt_to_equity: number | null;
  current_ratio: number | null;
  quick_ratio: number | null;
  revenue_growth: number | null;
  earnings_growth: number | null;
  revenue_ttm: number | null;
  gross_profit: number | null;
  ebitda: number | null;
  free_cash_flow: number | null;
  beta: number | null;
  fifty_two_week_high: number | null;
  fifty_two_week_low: number | null;
  shares_outstanding: number | null;
  promoter_holding: number | null;
  promoter_pledge: number | null;
  fii_holding: number | null;
  dii_holding: number | null;
  next_earnings_at: string | null;
  last_dividend_at: string | null;
  data_as_of: string | null;
  summary: string | null;
  website: string | null;
  employees: number | null;
};


const num = (v: any): number | null => {
  const raw = v?.raw ?? v;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  return Number.isFinite(n) ? n : null;
};

const iso = (v: any): string | null => {
  const raw = v?.raw ?? v;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return new Date(raw * 1000).toISOString();
};

// market_fundamentals_global stores ROE / ROCE / dividend yield / growth as
// PERCENT (market-fundamentals-sync writes `raw * 100`). The payload contract
// is decimal, so convert unconditionally — the old "> 0.5 must be percent"
// heuristic silently left small real yields (0.44% → rendered 44%) untouched.
const pctToRatio = (v: number | null): number | null => (v == null ? null : v / 100);


function normalize(symbol: string, exchange: string, r: any): Fundamentals {
  const sd = r?.summaryDetail ?? {};
  const ks = r?.defaultKeyStatistics ?? {};
  const fd = r?.financialData ?? {};
  const ap = r?.assetProfile ?? {};
  const pr = r?.price ?? {};
  const ce = r?.calendarEvents ?? {};
  const earnings = ce?.earnings ?? {};
  const nextEarnings = earnings?.earningsDate?.[0];
  const lastDiv = ce?.exDividendDate ?? sd?.exDividendDate;

  return {
    symbol,
    exchange,
    name: pr?.longName ?? pr?.shortName ?? null,
    sector: ap?.sector ?? null,
    industry: ap?.industry ?? null,
    market_cap: num(pr?.marketCap ?? sd?.marketCap),
    pe_ttm: num(sd?.trailingPE),
    pe_forward: num(sd?.forwardPE ?? ks?.forwardPE),
    peg: num(ks?.pegRatio),
    eps_ttm: num(ks?.trailingEps),
    eps_forward: num(ks?.forwardEps),
    book_value: num(ks?.bookValue),
    price_to_book: num(ks?.priceToBook),
    // Yahoo already reports these as decimals (0.0044 = 0.44% yield).
    dividend_yield: num(sd?.dividendYield),
    roe: num(fd?.returnOnEquity),
    roce: null,
    roa: num(fd?.returnOnAssets),
    profit_margin: num(fd?.profitMargins ?? ks?.profitMargins),
    operating_margin: num(fd?.operatingMargins),
    // Yahoo's debtToEquity is a PERCENT (51.4 means 0.51x). Convert to the
    // ratio the label promises instead of printing "Debt/Equity 51.40".
    debt_to_equity: pctToRatio(num(fd?.debtToEquity)),
    current_ratio: num(fd?.currentRatio),
    quick_ratio: num(fd?.quickRatio),
    revenue_growth: num(fd?.revenueGrowth),
    earnings_growth: num(fd?.earningsGrowth),
    revenue_ttm: num(fd?.totalRevenue),
    gross_profit: num(fd?.grossProfits),
    ebitda: num(fd?.ebitda),
    free_cash_flow: num(fd?.freeCashflow),
    beta: num(sd?.beta ?? ks?.beta),
    fifty_two_week_high: num(sd?.fiftyTwoWeekHigh),
    fifty_two_week_low: num(sd?.fiftyTwoWeekLow),
    shares_outstanding: num(ks?.sharesOutstanding),
    promoter_holding: null,
    promoter_pledge: null,
    fii_holding: null,
    dii_holding: null,
    next_earnings_at: iso(nextEarnings),
    last_dividend_at: iso(lastDiv),
    data_as_of: new Date().toISOString(),
    summary: ap?.longBusinessSummary ?? null,
    website: ap?.website ?? null,
    employees: num(ap?.fullTimeEmployees),
  };
}


async function fetchYahooFundamentals(symbol: string, exchange: string): Promise<Fundamentals> {
  const y = toYahooSymbol(symbol, exchange);
  // Crumb-authenticated — anonymous v10 quoteSummary now returns 401.
  const result = await yahooQuoteSummary(y, MODULES);
  if (!result) throw new Error(`Yahoo quoteSummary ${y}: unavailable (crumb/auth)`);
  return normalize(symbol, exchange, result);
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });

  try {
    const b = await req.json().catch(() => ({}));
    const symbol = String(b?.symbol ?? "").toUpperCase();
    const exchange = String(b?.exchange ?? "NSE").toUpperCase();
    const force = !!b?.force;
    if (!symbol) return errorResponse(req, "symbol required");
    const svc = svcClient();

    // Cache check: 24h TTL
    if (!force) {
      // Fundamentals are not personal data — reuse the freshest cached row for
      // this symbol regardless of which user warmed it, so every user gets the
      // same figures instead of an empty cache on first visit.
      const { data: cachedRows } = await svc.from("market_fundamentals")
        .select("payload,fetched_at")
        .eq("symbol", symbol).eq("exchange", exchange)
        .order("fetched_at", { ascending: false })
        .limit(1);
      const cached = cachedRows?.[0] ?? null;
      // Rows written before the unit fix carry no `data_as_of` and hold
      // debt_to_equity in Yahoo's percent form — ignore them so a stale cache
      // can't keep serving the wrong units.
      const cachedUnitsOk = !!(cached?.payload as any)?.data_as_of;
      if (cached && cachedUnitsOk && Date.now() - new Date(cached.fetched_at).getTime() < 24 * 3600_000) {
        return jsonResponse(req, { fundamentals: cached.payload, cached: true, fetched_at: cached.fetched_at });
      }

    }

    // Fallback to the global sync table (market_fundamentals_global) — the
    // universe-wide fundamentals sync writes here, not to the per-user cache
    // above. Map its column layout into the per-user payload shape so the
    // Analysis panel sees ROE / Beta / Div Yield / etc. even when the
    // Yahoo quoteSummary path is unavailable (rate-limited, crumb rotation).
    if (!force) {
      const { data: g } = await svc.from("market_fundamentals_global")
        .select("*").eq("symbol", symbol).eq("exchange", exchange).maybeSingle();
      const gAge = g?.updated_at ? Date.now() - new Date(g.updated_at).getTime() : Infinity;
      if (g && gAge < 7 * 24 * 3600_000) {
        // Everything percent-shaped in this table becomes a decimal fraction
        // here, exactly once — see the unit contract on `Fundamentals`.
        const mapped: Fundamentals = {
          symbol, exchange,
          name: g.company_name ?? null,
          sector: g.sector ?? null,
          industry: g.industry ?? null,
          market_cap: g.market_cap_cr != null ? Number(g.market_cap_cr) * 1e7 : null,
          pe_ttm: num(g.pe_ttm), pe_forward: null, peg: num(g.peg),
          eps_ttm: num(g.eps_ttm), eps_forward: null,
          book_value: num(g.book_value), price_to_book: num(g.pb),
          dividend_yield: pctToRatio(num(g.dividend_yield)),
          roe: pctToRatio(num(g.roe)),
          roce: pctToRatio(num(g.roce)),
          roa: null,
          profit_margin: null, operating_margin: null,
          // stored in Yahoo's percent form (51.4) — the label says ratio
          debt_to_equity: pctToRatio(num(g.debt_to_equity)),
          current_ratio: num(g.current_ratio),
          quick_ratio: num(g.quick_ratio),
          revenue_growth: pctToRatio(num(g.revenue_growth_yoy)),
          earnings_growth: pctToRatio(num(g.profit_growth_yoy)),
          revenue_ttm: g.revenue_ttm_cr != null ? Number(g.revenue_ttm_cr) * 1e7 : null,
          gross_profit: null, ebitda: null, free_cash_flow: null,
          beta: num(g.beta),
          fifty_two_week_high: num(g.high_52w),
          fifty_two_week_low: num(g.low_52w),
          shares_outstanding: null,
          // ownership stays in percent (0–100) — that's how it's published
          promoter_holding: num(g.promoter_holding),
          promoter_pledge: num(g.promoter_pledge),
          fii_holding: num(g.fii_holding),
          dii_holding: num(g.dii_holding),
          next_earnings_at: null, last_dividend_at: null,
          data_as_of: g.data_as_of ?? g.updated_at ?? null,
          summary: null, website: null, employees: null,
        };

        return jsonResponse(req, { fundamentals: mapped, cached: true, fetched_at: g.updated_at, source: "global" });
      }
    }

    const fundamentals = await fetchYahooFundamentals(symbol, exchange);
    await svc.from("market_fundamentals").upsert({
      user_id: auth.userId, symbol, exchange, payload: fundamentals, fetched_at: new Date().toISOString(),
    }, { onConflict: "user_id,symbol,exchange" });

    return jsonResponse(req, { fundamentals, cached: false, fetched_at: new Date().toISOString() });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
