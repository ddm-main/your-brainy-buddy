// Provider priority resolver — routes field requests to the right provider chain.
// Critical rule: store NULL when no provider has data (never substitute 0).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getActiveProvider } from "./provider.ts";
import { nseEquityMeta } from "./nseClient.ts";
import * as fmp from "./fmpClient.ts";
import * as alpha from "./alphaVantageClient.ts";
import { yahooQuote } from "./yahooClient.ts";

type FieldName = string;

export interface FieldRequest {
  field: FieldName;
  symbol: string;
  exchange: string;
}

export interface FieldResult {
  value: any;
  source: string;
}

type ProviderFn = (symbol: string, exchange: string) => Promise<any>;

interface Provider {
  name: string;
  fetch: ProviderFn;
}

// Provider priority chains per field type
const PRIORITY_CHAINS: Record<string, string[]> = {
  // Live price — Kotak (real-time) → Yahoo (delayed). Stooq used to be a
  // third fallback here, but its public CSV endpoint now sits behind a
  // browser JS anti-bot challenge a server-side fetch can't pass — kept out
  // of the chain rather than spending a doomed round-trip on every call
  // that falls through Kotak and Yahoo both.
  ltp: ["kotak", "yahoo"],
  previous_close: ["kotak", "yahoo"],
  volume: ["kotak", "yahoo"],
  change_abs: ["kotak", "yahoo"],
  change_pct: ["kotak", "yahoo"],

  // Fundamentals — FMP (clean data) → Yahoo (fast) → NSE (official)
  pe: ["fmp", "yahoo", "nse"],
  pb: ["fmp", "yahoo", "nse"],
  peg: ["fmp", "yahoo"],
  eps: ["fmp", "yahoo"],
  book_value: ["fmp", "yahoo"],
  dividend_yield: ["fmp", "yahoo"],
  roe: ["fmp", "yahoo"],
  roce: ["fmp"],
  roa: ["fmp"],
  operating_margin: ["fmp"],
  net_margin: ["fmp"],
  ev_ebitda: ["fmp"],

  // Growth
  sales_growth: ["fmp", "yahoo"],
  profit_growth: ["fmp", "yahoo"],
  eps_growth: ["fmp", "yahoo"],

  // Financial health
  debt_equity: ["fmp", "yahoo"],
  current_ratio: ["fmp", "yahoo"],
  quick_ratio: ["fmp", "yahoo"],
  interest_coverage: ["fmp"],
  cash_flow: ["fmp"],
  free_cash_flow: ["fmp"],

  // Company info
  company_name: ["fmp", "yahoo", "nse"],
  sector: ["fmp", "yahoo", "nse"],
  industry: ["fmp", "yahoo", "nse"],
  market_cap: ["fmp", "yahoo", "nse"],
  enterprise_value: ["fmp"],
  shares_outstanding: ["fmp", "yahoo"],
  face_value: ["yahoo"],

  // 52-week range
  high_52w: ["yahoo", "nse", "fmp"],
  low_52w: ["yahoo", "nse", "fmp"],
  beta: ["fmp", "yahoo"],

  // Technical indicators — Alpha Vantage (if quota available) → computed locally
  rsi: ["alpha", "computed"],
  macd: ["alpha", "computed"],
  macd_signal: ["alpha", "computed"],
  macd_hist: ["alpha", "computed"],
  adx: ["alpha", "computed"],
  atr: ["alpha", "computed"],
  sma_200: ["alpha", "computed"],
  sma_50: ["alpha", "computed"],
  sma_20: ["alpha", "computed"],
  ema_200: ["alpha", "computed"],
  ema_100: ["computed"],
  ema_50: ["alpha", "computed"],
  ema_20: ["alpha", "computed"],
  bb_upper: ["alpha", "computed"],
  bb_lower: ["alpha", "computed"],

  // Ownership — Yahoo only (NSE doesn't expose detailed shareholding in free API)
  promoter_holding: ["yahoo"],
  promoter_pledge: ["yahoo"],
  fii_holding: ["yahoo"],
  dii_holding: ["yahoo"],
};

// Map provider name → fetch function
async function getProviderFetcher(
  providerName: string,
  svc: SupabaseClient,
  userId: string | null,
): Promise<ProviderFn | null> {
  switch (providerName) {
    case "kotak": {
      const { provider } = await getActiveProvider(svc, userId ?? "");
      if (provider.name !== "kotak_neo") return null;
      return async (symbol, exchange) => {
        const quotes = await provider.getQuotes([`${exchange}:${symbol}`]);
        return quotes[0] ?? null;
      };
    }

    case "yahoo": {
      return async (symbol, exchange) => {
        const ySymbol = exchange === "BSE" ? `${symbol}.BO` : `${symbol}.NS`;
        const quotes = await yahooQuote([ySymbol]);
        return quotes[0] ?? null;
      };
    }

    case "nse": {
      return async (symbol, _exchange) => {
        return await nseEquityMeta(symbol);
      };
    }

    case "fmp": {
      return async (symbol, exchange) => {
        return await fmp.fmpFundamentals(symbol, exchange);
      };
    }

    case "alpha": {
      return async (symbol, exchange) => {
        return await alpha.alphaTechnicals(symbol, exchange);
      };
    }

    case "computed": {
      // Computed indicators are handled by the pipeline (market-pipeline-aggregates)
      // Resolver returns null here; caller should read from market_data table
      return null;
    }

    default:
      return null;
  }
}

// Extract field value from provider response
function extractFieldValue(field: FieldName, providerData: any, providerName: string): any {
  if (!providerData) return null;

  // Field name mapping per provider
  switch (providerName) {
    case "kotak":
    case "yahoo":
      // Quote responses
      if (field === "ltp") return providerData.price ?? null;
      if (field === "previous_close") return providerData.previous_close ?? providerData.prev_close ?? null;
      if (field === "volume") return providerData.volume ?? null;
      if (field === "change_abs") return providerData.change_abs ?? null;
      if (field === "change_pct") return providerData.change_pct ?? null;
      return null;

    case "nse":
      // NSE equity meta response
      if (field === "company_name") return providerData.companyName ?? null;
      if (field === "sector") return providerData.sector ?? null;
      if (field === "industry") return providerData.industry ?? null;
      if (field === "market_cap") return providerData.marketCapCr ?? null;
      if (field === "ltp") return providerData.price ?? null;
      if (field === "pe") return providerData.pe ?? null;
      if (field === "pb") return providerData.pb ?? null;
      if (field === "high_52w") return providerData.high52w ?? null;
      if (field === "low_52w") return providerData.low52w ?? null;
      return null;

    case "fmp": {
      // FMP fundamentals bundle
      const { profile, ratios, income, balance, cashFlow, growth } = providerData;
      if (field === "company_name") return profile?.company_name ?? null;
      if (field === "sector") return profile?.sector ?? null;
      if (field === "industry") return profile?.industry ?? null;
      if (field === "market_cap") return profile?.market_cap ?? null;
      if (field === "enterprise_value") return profile?.enterprise_value ?? null;
      if (field === "shares_outstanding") return profile?.shares_outstanding ?? null;
      if (field === "beta") return profile?.beta ?? null;
      if (field === "ltp") return profile?.ltp ?? null;
      if (field === "high_52w") return profile?.high_52w ?? null;
      if (field === "low_52w") return profile?.low_52w ?? null;

      if (field === "pe") return ratios?.pe ?? null;
      if (field === "pb") return ratios?.pb ?? null;
      if (field === "peg") return ratios?.peg ?? null;
      if (field === "roe") return ratios?.roe ?? null;
      if (field === "roce") return ratios?.roce ?? null;
      if (field === "roa") return ratios?.roa ?? null;
      if (field === "debt_equity") return ratios?.debt_equity ?? null;
      if (field === "current_ratio") return ratios?.current_ratio ?? null;
      if (field === "quick_ratio") return ratios?.quick_ratio ?? null;
      if (field === "interest_coverage") return ratios?.interest_coverage ?? null;
      if (field === "dividend_yield") return ratios?.dividend_yield ?? null;
      if (field === "ev_ebitda") return ratios?.ev_ebitda ?? null;

      if (field === "sales") return income?.sales ?? null;
      if (field === "net_profit") return income?.net_profit ?? null;
      if (field === "eps") return income?.eps ?? null;
      if (field === "operating_margin") return income?.operating_margin ?? null;
      if (field === "net_margin") return income?.net_margin ?? null;

      if (field === "debt") return balance?.debt ?? null;
      if (field === "book_value") return balance?.book_value ?? null;

      if (field === "cash_flow") return cashFlow?.cash_flow ?? null;
      if (field === "free_cash_flow") return cashFlow?.free_cash_flow ?? null;

      if (field === "sales_growth") return growth?.sales_growth ?? null;
      if (field === "profit_growth") return growth?.profit_growth ?? null;
      if (field === "eps_growth") return growth?.eps_growth ?? null;

      return null;
    }

    case "alpha": {
      // Alpha Vantage technicals
      if (field === "rsi") return providerData.rsi ?? null;
      if (field === "macd") return providerData.macd ?? null;
      if (field === "macd_signal") return providerData.macd_signal ?? null;
      if (field === "macd_hist") return providerData.macd_hist ?? null;
      if (field === "adx") return providerData.adx ?? null;
      if (field === "atr") return providerData.atr ?? null;
      if (field === "sma_200") return providerData.sma_200 ?? null;
      if (field === "sma_50") return providerData.sma_50 ?? null;
      if (field === "sma_20") return providerData.sma_20 ?? null;
      if (field === "ema_200") return providerData.ema_200 ?? null;
      if (field === "ema_50") return providerData.ema_50 ?? null;
      if (field === "ema_20") return providerData.ema_20 ?? null;
      if (field === "bb_upper") return providerData.bb_upper ?? null;
      if (field === "bb_lower") return providerData.bb_lower ?? null;
      return null;
    }

    default:
      return null;
  }
}

// Resolve a single field using the priority chain
export async function resolveField(
  req: FieldRequest,
  svc: SupabaseClient,
  userId: string | null = null,
): Promise<FieldResult | null> {
  const chain = PRIORITY_CHAINS[req.field] ?? [];

  for (const providerName of chain) {
    try {
      const fetcher = await getProviderFetcher(providerName, svc, userId);
      if (!fetcher) continue;

      const providerData = await fetcher(req.symbol, req.exchange);
      const value = extractFieldValue(req.field, providerData, providerName);

      if (value != null) {
        return { value, source: providerName };
      }
    } catch (e) {
      console.error(`Provider ${providerName} failed for ${req.field} (${req.exchange}:${req.symbol}):`, e);
      continue;
    }
  }

  return null; // Never substitute 0 for missing data
}

// Resolve multiple fields in parallel (batch mode)
export async function resolveFields(
  requests: FieldRequest[],
  svc: SupabaseClient,
  userId: string | null = null,
): Promise<Map<string, FieldResult | null>> {
  const results = await Promise.all(
    requests.map((req) => resolveField(req, svc, userId)),
  );

  const map = new Map<string, FieldResult | null>();
  for (let i = 0; i < requests.length; i++) {
    const key = `${requests[i].exchange}:${requests[i].symbol}:${requests[i].field}`;
    map.set(key, results[i]);
  }
  return map;
}
