// Alpha Vantage API client for technical indicators.
// Free tier: 25 requests/day. All field names mapped to unified schema.
// Docs: https://www.alphavantage.co/documentation/

import { getProviderKey } from "./providerKeys.ts";

const ALPHA_BASE = "https://www.alphavantage.co/query";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// Key comes from the admin-managed store (Market Config → Providers → Edit),
// falling back to the ALPHA_VANTAGE_API_KEY edge secret.
async function getAlphaApiKey(): Promise<string | null> {
  return await getProviderKey("alpha_vantage");
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

// Convert NSE symbol to Alpha Vantage format (usually just append .BSE or nothing for NSE)
function toAlphaSymbol(symbol: string, exchange: string): string {
  if (symbol.includes(".")) return symbol;
  // Alpha Vantage uses BSE suffix for BSE stocks
  return exchange === "BSE" ? `${symbol}.BSE` : symbol;
}

async function alphaFetch(params: Record<string, string>): Promise<any> {
  const apiKey = await getAlphaApiKey();
  if (!apiKey) throw new Error("Alpha Vantage API key not configured");

  const url = new URL(ALPHA_BASE);
  url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const r = await fetch(url.toString(), { headers: UA });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Alpha Vantage API ${r.status}: ${text.slice(0, 300)}`);
  }
  const json = await r.json();

  // Alpha Vantage returns error messages in the response body
  if (json["Error Message"] || json["Note"]) {
    throw new Error(json["Error Message"] ?? json["Note"]);
  }

  return json;
}

// Extract the most recent value from Alpha Vantage time series
function getLatestValue(data: any, metaKey: string, dataKey: string, valueKey: string): number | null {
  const series = data[dataKey];
  if (!series || typeof series !== "object") return null;

  const dates = Object.keys(series).sort().reverse();
  if (dates.length === 0) return null;

  const latest = series[dates[0]];
  return num(latest?.[valueKey]);
}

export async function alphaSMA(symbol: string, exchange = "NSE", period = 20): Promise<number | null> {
  const alphaSym = toAlphaSymbol(symbol, exchange);
  try {
    const data = await alphaFetch({
      function: "SMA",
      symbol: alphaSym,
      interval: "daily",
      time_period: String(period),
      series_type: "close",
    });
    return getLatestValue(data, "Meta Data", "Technical Analysis: SMA", "SMA");
  } catch (e) {
    console.error(`Alpha SMA(${period}) failed for ${alphaSym}:`, e);
    return null;
  }
}

export async function alphaEMA(symbol: string, exchange = "NSE", period = 20): Promise<number | null> {
  const alphaSym = toAlphaSymbol(symbol, exchange);
  try {
    const data = await alphaFetch({
      function: "EMA",
      symbol: alphaSym,
      interval: "daily",
      time_period: String(period),
      series_type: "close",
    });
    return getLatestValue(data, "Meta Data", "Technical Analysis: EMA", "EMA");
  } catch (e) {
    console.error(`Alpha EMA(${period}) failed for ${alphaSym}:`, e);
    return null;
  }
}

export async function alphaRSI(symbol: string, exchange = "NSE", period = 14): Promise<number | null> {
  const alphaSym = toAlphaSymbol(symbol, exchange);
  try {
    const data = await alphaFetch({
      function: "RSI",
      symbol: alphaSym,
      interval: "daily",
      time_period: String(period),
      series_type: "close",
    });
    return getLatestValue(data, "Meta Data", "Technical Analysis: RSI", "RSI");
  } catch (e) {
    console.error(`Alpha RSI failed for ${alphaSym}:`, e);
    return null;
  }
}

export interface AlphaMacd {
  macd: number | null;
  macd_signal: number | null;
  macd_hist: number | null;
}

export async function alphaMACD(symbol: string, exchange = "NSE"): Promise<AlphaMacd | null> {
  const alphaSym = toAlphaSymbol(symbol, exchange);
  try {
    const data = await alphaFetch({
      function: "MACD",
      symbol: alphaSym,
      interval: "daily",
      series_type: "close",
    });

    const series = data["Technical Analysis: MACD"];
    if (!series || typeof series !== "object") return null;

    const dates = Object.keys(series).sort().reverse();
    if (dates.length === 0) return null;

    const latest = series[dates[0]];
    return {
      macd: num(latest?.["MACD"]),
      macd_signal: num(latest?.["MACD_Signal"]),
      macd_hist: num(latest?.["MACD_Hist"]),
    };
  } catch (e) {
    console.error(`Alpha MACD failed for ${alphaSym}:`, e);
    return null;
  }
}

export async function alphaADX(symbol: string, exchange = "NSE", period = 14): Promise<number | null> {
  const alphaSym = toAlphaSymbol(symbol, exchange);
  try {
    const data = await alphaFetch({
      function: "ADX",
      symbol: alphaSym,
      interval: "daily",
      time_period: String(period),
    });
    return getLatestValue(data, "Meta Data", "Technical Analysis: ADX", "ADX");
  } catch (e) {
    console.error(`Alpha ADX failed for ${alphaSym}:`, e);
    return null;
  }
}

export async function alphaATR(symbol: string, exchange = "NSE", period = 14): Promise<number | null> {
  const alphaSym = toAlphaSymbol(symbol, exchange);
  try {
    const data = await alphaFetch({
      function: "ATR",
      symbol: alphaSym,
      interval: "daily",
      time_period: String(period),
    });
    return getLatestValue(data, "Meta Data", "Technical Analysis: ATR", "ATR");
  } catch (e) {
    console.error(`Alpha ATR failed for ${alphaSym}:`, e);
    return null;
  }
}

export interface AlphaBBands {
  bb_upper: number | null;
  bb_middle: number | null;
  bb_lower: number | null;
}

export async function alphaBBands(symbol: string, exchange = "NSE", period = 20): Promise<AlphaBBands | null> {
  const alphaSym = toAlphaSymbol(symbol, exchange);
  try {
    const data = await alphaFetch({
      function: "BBANDS",
      symbol: alphaSym,
      interval: "daily",
      time_period: String(period),
      series_type: "close",
    });

    const series = data["Technical Analysis: BBANDS"];
    if (!series || typeof series !== "object") return null;

    const dates = Object.keys(series).sort().reverse();
    if (dates.length === 0) return null;

    const latest = series[dates[0]];
    return {
      bb_upper: num(latest?.["Real Upper Band"]),
      bb_middle: num(latest?.["Real Middle Band"]),
      bb_lower: num(latest?.["Real Lower Band"]),
    };
  } catch (e) {
    console.error(`Alpha BBands failed for ${alphaSym}:`, e);
    return null;
  }
}

// Fetch multiple moving averages in parallel (rate limit aware)
export async function alphaMovingAverages(symbol: string, exchange = "NSE") {
  // Alpha Vantage free tier: 25 requests/day
  // Fetch SMA 20/50/200 and EMA 20/50/200 (6 requests)
  const [sma20, sma50, sma200, ema20, ema50, ema200] = await Promise.allSettled([
    alphaSMA(symbol, exchange, 20),
    alphaSMA(symbol, exchange, 50),
    alphaSMA(symbol, exchange, 200),
    alphaEMA(symbol, exchange, 20),
    alphaEMA(symbol, exchange, 50),
    alphaEMA(symbol, exchange, 200),
  ]);

  return {
    sma_20: sma20.status === "fulfilled" ? sma20.value : null,
    sma_50: sma50.status === "fulfilled" ? sma50.value : null,
    sma_200: sma200.status === "fulfilled" ? sma200.value : null,
    ema_20: ema20.status === "fulfilled" ? ema20.value : null,
    ema_50: ema50.status === "fulfilled" ? ema50.value : null,
    ema_200: ema200.status === "fulfilled" ? ema200.value : null,
  };
}

// Fetch all technical indicators (9 requests total: 6 MAs + RSI + MACD + ADX)
export async function alphaTechnicals(symbol: string, exchange = "NSE") {
  const [mas, rsi, macd, adx, atr, bbands] = await Promise.allSettled([
    alphaMovingAverages(symbol, exchange),
    alphaRSI(symbol, exchange),
    alphaMACD(symbol, exchange),
    alphaADX(symbol, exchange),
    alphaATR(symbol, exchange),
    alphaBBands(symbol, exchange),
  ]);

  const masData = mas.status === "fulfilled" ? mas.value : {};
  const macdData = macd.status === "fulfilled" ? macd.value : null;
  const bbandsData = bbands.status === "fulfilled" ? bbands.value : null;

  return {
    ...masData,
    rsi: rsi.status === "fulfilled" ? rsi.value : null,
    macd: macdData?.macd ?? null,
    macd_signal: macdData?.macd_signal ?? null,
    macd_hist: macdData?.macd_hist ?? null,
    adx: adx.status === "fulfilled" ? adx.value : null,
    atr: atr.status === "fulfilled" ? atr.value : null,
    bb_upper: bbandsData?.bb_upper ?? null,
    bb_middle: bbandsData?.bb_middle ?? null,
    bb_lower: bbandsData?.bb_lower ?? null,
  };
}
