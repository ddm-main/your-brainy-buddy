// Financial Modeling Prep API client for fundamental data.
// Free tier: 250 requests/day. All field names mapped to unified schema.
// Docs: https://site.financialmodelingprep.com/developer/docs

import { getProviderKey, type ProviderKeyOptions } from "./providerKeys.ts";

const FMP_STABLE_BASE = "https://financialmodelingprep.com/stable";
const FMP_LEGACY_BASE = "https://financialmodelingprep.com/api/v3";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// Key comes from the admin-managed store (Market Config → Providers → Edit),
// falling back to the FINANCIAL_MODELING_PREP_API_KEY edge secret.
async function getFmpApiKey(options: ProviderKeyOptions = {}): Promise<string | null> {
  return await getProviderKey("fmp", options);
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

// Convert NSE symbol to FMP symbol format (usually just append .NS)
function toFmpSymbol(symbol: string, exchange: string): string {
  if (symbol.includes(".")) return symbol;
  if (exchange === "BSE") return `${symbol}.BO`;
  if (exchange === "NSE") return `${symbol}.NS`;
  return symbol;
}

class FmpApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`FMP API ${status}: ${body.slice(0, 300)}`);
  }
}

function stableRouteFor(path: string, params: Record<string, string>): { path: string; params: Record<string, string> } | null {
  const m = path.match(/^\/(profile|ratios-ttm|income-statement|balance-sheet-statement|cash-flow-statement|financial-growth)\/(.+)$/);
  if (!m) return null;
  return { path: `/${m[1]}`, params: { ...params, symbol: decodeURIComponent(m[2]) } };
}

function shouldFallbackToLegacy(e: unknown): boolean {
  if (!(e instanceof FmpApiError)) return false;
  if (e.status === 404) return true;
  return /not found|unknown endpoint|cannot get/i.test(e.body)
    && !/invalid api key|limit|quota|subscription|plan/i.test(e.body);
}

async function fmpRequest(base: string, path: string, params: Record<string, string>, options: ProviderKeyOptions = {}): Promise<any> {
  const apiKey = await getFmpApiKey(options);
  if (!apiKey) throw new Error("FMP API key not configured");

  const url = new URL(`${base}${path}`);
  url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const r = await fetch(url.toString(), { headers: UA });
  if (!r.ok) {
    const text = await r.text();
    throw new FmpApiError(r.status, text);
  }
  const json = await r.json();
  if (json?.["Error Message"] || json?.error || json?.message) {
    const body = String(json["Error Message"] ?? json.error ?? json.message);
    throw new FmpApiError(200, body);
  }
  return json;
}

async function fmpFetch(path: string, params: Record<string, string> = {}, options: ProviderKeyOptions = {}): Promise<any> {
  const stable = stableRouteFor(path, params);
  if (stable) {
    try {
      return await fmpRequest(FMP_STABLE_BASE, stable.path, stable.params, options);
    } catch (e) {
      if (!shouldFallbackToLegacy(e)) throw e;
    }
  }
  return await fmpRequest(FMP_LEGACY_BASE, path, params, options);
}

/** Lightweight key validation against a high-coverage US symbol. */
export async function fmpValidateKey(options: ProviderKeyOptions = {}): Promise<{ ok: boolean; detail: string }> {
  const data = await fmpFetch("/profile/AAPL", {}, options);
  if (!Array.isArray(data) || data.length === 0) return { ok: false, detail: "FMP key accepted, but profile probe returned no data" };
  const name = str(data[0]?.companyName, data[0]?.company_name, data[0]?.name) ?? "AAPL";
  return { ok: true, detail: `FMP reachable — ${name}` };
}

export interface FmpProfile {
  symbol: string;
  company_name: string | null;
  sector: string | null;
  industry: string | null;
  market_cap: number | null; // ₹ Cr (converted from USD)
  enterprise_value: number | null; // ₹ Cr
  shares_outstanding: number | null; // in Cr
  beta: number | null;
  ltp: number | null;
  high_52w: number | null;
  low_52w: number | null;
}

// Company profile + current price
export async function fmpProfile(symbol: string, exchange = "NSE"): Promise<FmpProfile | null> {
  const fmpSym = toFmpSymbol(symbol, exchange);
  try {
    const data = await fmpFetch(`/profile/${fmpSym}`);
    if (!Array.isArray(data) || data.length === 0) return null;
    const p = data[0];

    // FMP returns USD values; convert to INR (approx 83 INR/USD as of 2026)
    const usdToInr = 83;
    const marketCapCr = num(p.mktCap) ? num(p.mktCap)! / 1e7 * usdToInr : null;
    const evCr = num(p.enterpriseValue) ? num(p.enterpriseValue)! / 1e7 * usdToInr : null;
    const sharesCr = num(p.sharesOutstanding) ? num(p.sharesOutstanding)! / 1e7 : null;

    // `range` is a "low-high" string (e.g. "1234.56-2345.67") — running it
    // through num() first (as the old code did) always returns null, since
    // Number() can't parse a hyphenated range as a single value, so that
    // branch of the old ternary was silently dead and this always fell back
    // to 52WeekHigh/52WeekLow regardless of what `range` actually held.
    // Split the string directly instead.
    const [rangeLow, rangeHigh] = typeof p.range === "string"
      ? p.range.split("-").map((s: string) => Number(s.trim()))
      : [NaN, NaN];

    return {
      symbol: fmpSym,
      company_name: str(p.companyName, p.name),
      sector: str(p.sector),
      industry: str(p.industry),
      market_cap: marketCapCr,
      enterprise_value: evCr,
      shares_outstanding: sharesCr,
      beta: num(p.beta),
      ltp: num(p.price, p.lastPrice),
      high_52w: Number.isFinite(rangeHigh) ? rangeHigh : num(p["52WeekHigh"]),
      low_52w: Number.isFinite(rangeLow) ? rangeLow : num(p["52WeekLow"]),
    };
  } catch (e) {
    console.error(`FMP profile failed for ${fmpSym}:`, e);
    return null;
  }
}

export interface FmpRatios {
  pe: number | null;
  pb: number | null;
  peg: number | null;
  roe: number | null;
  roce: number | null;
  roa: number | null;
  debt_equity: number | null;
  current_ratio: number | null;
  quick_ratio: number | null;
  interest_coverage: number | null;
  dividend_yield: number | null;
  ev_ebitda: number | null;
}

// Financial ratios (TTM)
export async function fmpRatios(symbol: string, exchange = "NSE"): Promise<FmpRatios | null> {
  const fmpSym = toFmpSymbol(symbol, exchange);
  try {
    const data = await fmpFetch(`/ratios-ttm/${fmpSym}`);
    if (!Array.isArray(data) || data.length === 0) return null;
    const r = data[0];

    return {
      pe: num(r.peRatioTTM, r.priceEarningsRatioTTM),
      pb: num(r.pbRatioTTM, r.priceToBookRatioTTM),
      peg: num(r.pegRatioTTM),
      roe: num(r.returnOnEquityTTM, r.roeTTM) ? num(r.returnOnEquityTTM, r.roeTTM)! * 100 : null,
      roce: num(r.returnOnCapitalEmployedTTM, r.roceTTM) ? num(r.returnOnCapitalEmployedTTM, r.roceTTM)! * 100 : null,
      roa: num(r.returnOnAssetsTTM, r.roaTTM) ? num(r.returnOnAssetsTTM, r.roaTTM)! * 100 : null,
      debt_equity: num(r.debtEquityRatioTTM),
      current_ratio: num(r.currentRatioTTM),
      quick_ratio: num(r.quickRatioTTM),
      interest_coverage: num(r.interestCoverageTTM),
      dividend_yield: num(r.dividendYieldTTM, r.dividendYieldPercentageTTM),
      ev_ebitda: num(r.enterpriseValueMultipleTTM),
    };
  } catch (e) {
    console.error(`FMP ratios failed for ${fmpSym}:`, e);
    return null;
  }
}

export interface FmpIncomeStatement {
  sales: number | null; // revenue ₹ Cr
  net_profit: number | null; // ₹ Cr
  eps: number | null;
  operating_margin: number | null; // %
  net_margin: number | null; // %
}

// Income statement (most recent annual or TTM)
export async function fmpIncomeStatement(symbol: string, exchange = "NSE"): Promise<FmpIncomeStatement | null> {
  const fmpSym = toFmpSymbol(symbol, exchange);
  try {
    const data = await fmpFetch(`/income-statement/${fmpSym}`, { limit: "1" });
    if (!Array.isArray(data) || data.length === 0) return null;
    const i = data[0];

    const usdToInr = 83;
    const revenueCr = num(i.revenue) ? num(i.revenue)! / 1e7 * usdToInr : null;
    const profitCr = num(i.netIncome) ? num(i.netIncome)! / 1e7 * usdToInr : null;
    const opMargin = num(i.operatingIncomeRatio) ? num(i.operatingIncomeRatio)! * 100 : null;
    const netMargin = num(i.netIncomeRatio) ? num(i.netIncomeRatio)! * 100 : null;

    return {
      sales: revenueCr,
      net_profit: profitCr,
      eps: num(i.eps, i.epsdiluted),
      operating_margin: opMargin,
      net_margin: netMargin,
    };
  } catch (e) {
    console.error(`FMP income statement failed for ${fmpSym}:`, e);
    return null;
  }
}

export interface FmpBalanceSheet {
  debt: number | null; // total debt ₹ Cr
  book_value: number | null; // per share
}

// Balance sheet (most recent)
export async function fmpBalanceSheet(symbol: string, exchange = "NSE"): Promise<FmpBalanceSheet | null> {
  const fmpSym = toFmpSymbol(symbol, exchange);
  try {
    const data = await fmpFetch(`/balance-sheet-statement/${fmpSym}`, { limit: "1" });
    if (!Array.isArray(data) || data.length === 0) return null;
    const b = data[0];

    const usdToInr = 83;
    const debtCr = num(b.totalDebt) ? num(b.totalDebt)! / 1e7 * usdToInr : null;

    return {
      debt: debtCr,
      book_value: num(b.bookValuePerShare),
    };
  } catch (e) {
    console.error(`FMP balance sheet failed for ${fmpSym}:`, e);
    return null;
  }
}

export interface FmpCashFlow {
  cash_flow: number | null; // operating cash flow ₹ Cr
  free_cash_flow: number | null; // ₹ Cr
}

// Cash flow statement (most recent)
export async function fmpCashFlow(symbol: string, exchange = "NSE"): Promise<FmpCashFlow | null> {
  const fmpSym = toFmpSymbol(symbol, exchange);
  try {
    const data = await fmpFetch(`/cash-flow-statement/${fmpSym}`, { limit: "1" });
    if (!Array.isArray(data) || data.length === 0) return null;
    const c = data[0];

    const usdToInr = 83;
    const ocfCr = num(c.operatingCashFlow) ? num(c.operatingCashFlow)! / 1e7 * usdToInr : null;
    const fcfCr = num(c.freeCashFlow) ? num(c.freeCashFlow)! / 1e7 * usdToInr : null;

    return {
      cash_flow: ocfCr,
      free_cash_flow: fcfCr,
    };
  } catch (e) {
    console.error(`FMP cash flow failed for ${fmpSym}:`, e);
    return null;
  }
}

export interface FmpGrowth {
  sales_growth: number | null; // YoY %
  profit_growth: number | null; // YoY %
  eps_growth: number | null; // YoY %
}

// Financial growth metrics (YoY)
export async function fmpGrowth(symbol: string, exchange = "NSE"): Promise<FmpGrowth | null> {
  const fmpSym = toFmpSymbol(symbol, exchange);
  try {
    const data = await fmpFetch(`/financial-growth/${fmpSym}`, { limit: "1" });
    if (!Array.isArray(data) || data.length === 0) return null;
    const g = data[0];

    return {
      sales_growth: num(g.revenueGrowth) ? num(g.revenueGrowth)! * 100 : null,
      profit_growth: num(g.netIncomeGrowth) ? num(g.netIncomeGrowth)! * 100 : null,
      eps_growth: num(g.epsgrowth, g.epsGrowth) ? num(g.epsgrowth, g.epsGrowth)! * 100 : null,
    };
  } catch (e) {
    console.error(`FMP growth failed for ${fmpSym}:`, e);
    return null;
  }
}

// Fetch all fundamental data in one go (6 endpoints)
export async function fmpFundamentals(symbol: string, exchange = "NSE") {
  const [profile, ratios, income, balance, cashFlow, growth] = await Promise.allSettled([
    fmpProfile(symbol, exchange),
    fmpRatios(symbol, exchange),
    fmpIncomeStatement(symbol, exchange),
    fmpBalanceSheet(symbol, exchange),
    fmpCashFlow(symbol, exchange),
    fmpGrowth(symbol, exchange),
  ]);

  return {
    profile: profile.status === "fulfilled" ? profile.value : null,
    ratios: ratios.status === "fulfilled" ? ratios.value : null,
    income: income.status === "fulfilled" ? income.value : null,
    balance: balance.status === "fulfilled" ? balance.value : null,
    cashFlow: cashFlow.status === "fulfilled" ? cashFlow.value : null,
    growth: growth.status === "fulfilled" ? growth.value : null,
  };
}
