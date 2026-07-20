// Stooq API client for backup historical price data.
// Free, no API key required. CSV-based endpoint.
// Docs: https://stooq.com/db/h/

import type { Candle } from "./indicators.ts";

const STOOQ_BASE = "https://stooq.com/q/d/l";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// Convert NSE/BSE symbol to Stooq format
// Stooq uses .IN for India stocks (not .NS/.BO)
function toStooqSymbol(symbol: string, exchange: string): string {
  if (symbol.includes(".")) return symbol;
  return `${symbol}.IN`;
}

const num = (v: string): number | null => {
  if (!v || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Parse Stooq CSV response into Candle[]
// Format: Date,Open,High,Low,Close,Volume
function parseStooqCsv(csv: string): Candle[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return []; // header + at least 1 data row

  const candles: Candle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 6) continue;

    const [dateStr, openStr, highStr, lowStr, closeStr, volumeStr] = parts;
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) continue;

    const open = num(openStr);
    const high = num(highStr);
    const low = num(lowStr);
    const close = num(closeStr);
    const volume = num(volumeStr);

    if (open == null || high == null || low == null || close == null) continue;

    candles.push({
      time: Math.floor(date.getTime() / 1000),
      open,
      high,
      low,
      close,
      volume: volume ?? 0,
    });
  }

  return candles;
}

export async function stooqDailyPrices(
  symbol: string,
  exchange = "NSE",
  range = "1y",
): Promise<Candle[]> {
  const stooqSym = toStooqSymbol(symbol, exchange);

  // Stooq params:
  // s = symbol
  // d1 = start date (YYYYMMDD)
  // d2 = end date (YYYYMMDD)
  // i = interval (d = daily, w = weekly, m = monthly)
  const now = new Date();
  const rangeDays: Record<string, number> = {
    "1d": 1,
    "5d": 5,
    "30d": 30,
    "60d": 60,
    "1y": 365,
    "2y": 730,
  };
  const days = rangeDays[range] ?? 365;
  const startDate = new Date(now.getTime() - days * 86_400_000);

  const d1 = startDate.toISOString().slice(0, 10).replace(/-/g, "");
  const d2 = now.toISOString().slice(0, 10).replace(/-/g, "");

  const url = `${STOOQ_BASE}/?s=${encodeURIComponent(stooqSym)}&d1=${d1}&d2=${d2}&i=d`;

  try {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) {
      throw new Error(`Stooq API ${r.status}`);
    }
    const csv = await r.text();
    return parseStooqCsv(csv);
  } catch (e) {
    console.error(`Stooq daily prices failed for ${stooqSym}:`, e);
    return [];
  }
}

// Get latest close price from Stooq (useful as fallback for LTP)
export async function stooqLatestPrice(symbol: string, exchange = "NSE"): Promise<number | null> {
  const candles = await stooqDailyPrices(symbol, exchange, "5d");
  if (candles.length === 0) return null;
  return candles[candles.length - 1].close;
}
