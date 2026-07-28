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
  day_open?: number | null;
  day_high?: number | null;
  day_low?: number | null;
  prev_close?: number | null;
  prev_close_as_of?: string | null;
  as_of?: string | null;
}

const istDateKey = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

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
    // Use a 5-day window so we can derive prev close from the actual prior
    // daily bar. Yahoo's meta.chartPreviousClose is occasionally stale
    // (returns a value from days ago), which corrupts day-change math.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) return null;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      const meta = res?.meta;
      const price = meta?.regularMarketPrice;
      if (price == null) return null;

      // Derive prev close from the completed daily bar before the quote's own
      // trading date. This avoids Yahoo's occasionally stale chartPreviousClose
      // and also makes non-trading-day "today" changes settle to zero upstream.
      let prev: number | null = null;
      let prevDate: string | null = null;
      const ts: number[] = res?.timestamp ?? [];
      const closes: (number | null)[] = res?.indicators?.quote?.[0]?.close ?? [];
      const quoteDate = meta?.regularMarketTime ? istDateKey(new Date(Number(meta.regularMarketTime) * 1000)) : istDateKey(new Date());
      for (let i = ts.length - 1; i >= 0; i--) {
        const c = closes[i];
        if (c == null) continue;
        const key = istDateKey(new Date(ts[i] * 1000));
        if (key >= quoteDate) continue;
        prev = Number(c);
        prevDate = key;
        break;
      }
      if (prev == null) {
        prev = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
      }
      // Day OHL for the current session, taken from the chart bar stamped
      // with the quote's own trading date (meta's regularMarketDayHigh/Low
      // are the fallback; meta carries no open at all).
      let dayOpen: number | null = null, dayHigh: number | null = null, dayLow: number | null = null;
      const q0 = res?.indicators?.quote?.[0] ?? {};
      for (let i = ts.length - 1; i >= 0; i--) {
        if (istDateKey(new Date(ts[i] * 1000)) !== quoteDate) continue;
        dayOpen = q0.open?.[i] ?? null;
        dayHigh = q0.high?.[i] ?? null;
        dayLow = q0.low?.[i] ?? null;
        break;
      }
      const changeAbs = prev != null ? price - prev : null;
      return {
        symbol: meta.symbol ?? symbol,
        name: meta.longName ?? meta.shortName ?? symbol,
        price,
        change_abs: changeAbs,
        change_pct: changeAbs != null && prev ? (changeAbs / prev) * 100 : null,
        volume: meta.regularMarketVolume ?? null,
        day_open: dayOpen,
        day_high: dayHigh ?? meta.regularMarketDayHigh ?? null,
        day_low: dayLow ?? meta.regularMarketDayLow ?? null,
        prev_close: prev,
        prev_close_as_of: prevDate,
        as_of: quoteDate,
      };
    } catch {
      return null;
    }
  }
}

// Historical candles via the chart API (works per-symbol, more reliable than v7).
//
// IMPORTANT: `range=max` is a trap. For daily/intraday intervals Yahoo silently
// IGNORES the requested interval and returns MONTHLY bars (e.g. HUHTAMAKI.NS:
// 290 month-end rows instead of ~5,990 daily ones). Writing those into
// market_daily_prices corrupted years of "daily" history. For any interval
// finer than 1wk we therefore ask for the full window explicitly with
// period1/period2, which returns true daily bars back to the listing date.
export async function yahooChart(
  yahooSymbol: string,
  range = "2y",
  interval = "1d",
): Promise<Candle[]> {
  const coarse = interval === "1wk" || interval === "1mo" || interval === "3mo";
  const window = range === "max" && !coarse
    ? `period1=0&period2=${Math.floor(Date.now() / 1000)}`
    : `range=${range}`;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
    `?${window}&interval=${interval}&events=div%2Csplit`;
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

export interface YahooNewsItem {
  headline: string;
  url: string | null;
  source: string | null;
  published_at: string | null;
}

// Yahoo's per-symbol RSS headline feed is dead for NSE tickers: it answers
// 200 with an empty <channel> (verified 2026-07-27 for RELIANCE.NS), and
// v1/finance/search returns unrelated US wire stories for Indian queries.
// Google News' RSS search does cover Indian market press, needs no auth,
// and returns a small predictable XML shape — regex extraction is enough.
export async function fetchStockNews(
  symbol: string,
  companyName?: string | null,
): Promise<{ items: YahooNewsItem[]; error: string | null }> {
  const subject = (companyName ?? "").trim() || symbol;
  const q = `"${subject}" (share OR stock OR results)`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
  let xml: string;
  try {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) return { items: [], error: `news feed ${r.status}` };
    xml = await r.text();
  } catch (e) {
    return { items: [], error: e instanceof Error ? e.message : String(e) };
  }

  const items: YahooNewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  const tag = (block: string, name: string): string | null => {
    const m = block.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`));
    return m ? m[1].trim() : null;
  };
  const unescape = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const rawTitle = tag(block, "title");
    const link = tag(block, "link");
    // Google appends " - Publisher" to every headline; the publisher is also
    // in <source>, so strip the duplicate suffix.
    const source = tag(block, "source");
    let headline = rawTitle ? unescape(rawTitle) : null;
    if (headline && source && headline.endsWith(` - ${unescape(source)}`)) {
      headline = headline.slice(0, -(unescape(source).length + 3)).trim();
    }
    // The unique index is (symbol, exchange, url) — a null url can never
    // dedupe, so those rows would pile up on every sync. Skip them.
    if (!headline || !link) continue;
    const pubDateRaw = tag(block, "pubDate");
    const publishedAt = pubDateRaw ? new Date(pubDateRaw) : null;
    items.push({
      headline,
      url: link,
      source: source ? unescape(source) : "Google News",
      published_at: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt.toISOString() : null,
    });
  }
  return { items, error: null };
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
