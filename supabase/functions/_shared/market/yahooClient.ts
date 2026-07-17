// Yahoo Finance client — quotes + historical OHLCV chart data.
// Unofficial API: always send a browser User-Agent; expect occasional 429s.

import type { Candle } from "./indicators.ts";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

export function toYahooSymbol(symbol: string, exchange = "NSE"): string {
  if (symbol.startsWith("^") || symbol.includes(".")) return symbol;
  return exchange === "BSE" ? `${symbol}.BO` : `${symbol}.NS`;
}

export interface YahooQuoteRow {
  symbol: string;
  name: string;
  price: number;
  change_abs: number | null;
  change_pct: number | null;
  volume?: number | null;
  prev_close?: number | null;
}

// The v7/finance/quote endpoint now requires Yahoo's crumb+cookie auth and
// returns 401 for anonymous callers, so quotes are read from the v8 chart
// meta instead (same anonymous access the pipeline's yahooChart relies on).
export async function yahooQuote(symbols: string[]): Promise<YahooQuoteRow[]> {
  if (symbols.length === 0) return [];
  // One chart call per symbol now, so cap concurrency to stay under Yahoo's
  // anonymous rate limits when quoting a whole watchlist.
  const CHUNK = 8;
  const rows: (YahooQuoteRow | null)[] = [];
  for (let i = 0; i < symbols.length; i += CHUNK) {
    rows.push(...await Promise.all(symbols.slice(i, i + CHUNK).map(fetchOne)));
  }
  return rows.filter((r): r is YahooQuoteRow => r !== null);

  async function fetchOne(symbol: string): Promise<YahooQuoteRow | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) return null;
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      if (price == null) return null;
      const prev = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
      const changeAbs = prev != null ? price - prev : null;
      return {
        symbol: meta.symbol ?? symbol,
        name: meta.longName ?? meta.shortName ?? symbol,
        price,
        change_abs: changeAbs,
        change_pct: changeAbs != null && prev ? (changeAbs / prev) * 100 : null,
        volume: meta.regularMarketVolume ?? null,
        prev_close: prev,
      };
    } catch {
      return null;
    }
  }
}

// Historical candles via the chart API (works per-symbol, more reliable than v7).
export async function yahooChart(
  yahooSymbol: string,
  range = "2y",
  interval = "1d",
): Promise<Candle[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
    `?range=${range}&interval=${interval}&events=div%2Csplit`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`yahoo chart ${yahooSymbol}: HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`yahoo chart ${yahooSymbol}: empty result`);
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];
    if (open == null || high == null || low == null || close == null) continue;
    out.push({
      time: ts[i],
      open,
      high,
      low,
      close,
      volume: q.volume?.[i] ?? 0,
    });
  }
  return out;
}

// Small retry helper for 429s
export async function yahooChartRetry(
  yahooSymbol: string,
  range = "2y",
  interval = "1d",
  attempts = 2,
): Promise<Candle[]> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await yahooChart(yahooSymbol, range, interval);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("429")) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      else if (i === attempts - 1) break;
    }
  }
  throw lastErr;
}
