// Refreshes the shared public.market_quotes cache from Yahoo Finance's
// keyless quote endpoint. Indices (Nifty/Sensex/Bank Nifty/Dow/Nasdaq/S&P),
// FX (USD/INR), commodities (gold/crude), plus any tracked stock symbol.
// Rate-limited per user (1/5min) and safe to call opportunistically from
// the Intelligence page. Writes bypass RLS via service role; every
// authenticated user reads the same shared cache.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";
import { safeFetch } from "../_shared/http.ts";

const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

// Symbol → (display name, kind, currency). Yahoo tickers are the source
// of truth; the entry order defines the strip order in Intelligence.
const TRACKED: { symbol: string; name: string; kind: "index" | "fx" | "commodity" | "crypto"; currency: string }[] = [
  { symbol: "^NSEI",   name: "Nifty 50",     kind: "index",     currency: "INR" },
  { symbol: "^BSESN",  name: "Sensex",       kind: "index",     currency: "INR" },
  { symbol: "^NSEBANK",name: "Bank Nifty",   kind: "index",     currency: "INR" },
  { symbol: "^DJI",    name: "Dow Jones",    kind: "index",     currency: "USD" },
  { symbol: "^IXIC",   name: "Nasdaq",       kind: "index",     currency: "USD" },
  { symbol: "^GSPC",   name: "S&P 500",      kind: "index",     currency: "USD" },
  { symbol: "INR=X",   name: "USD / INR",    kind: "fx",        currency: "INR" },
  { symbol: "GC=F",    name: "Gold (spot)",  kind: "commodity", currency: "USD" },
  { symbol: "CL=F",    name: "Crude Oil",    kind: "commodity", currency: "USD" },
  { symbol: "BTC-USD", name: "Bitcoin",      kind: "crypto",    currency: "USD" },
];

const limiter = createSlidingWindowLimiter(1, 5 * 60_000);

interface YahooQuoteResult {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
}

async function fetchQuotes(symbols: string[]): Promise<YahooQuoteResult[]> {
  const symbolsCsv = encodeURIComponent(symbols.join(","));
  const path = `/v7/finance/quote?symbols=${symbolsCsv}`;
  // Yahoo occasionally 401s on one host, 200s on the other. Fail-over quickly.
  for (const host of YAHOO_HOSTS) {
    const r = await safeFetch(`https://${host}${path}`, {
      timeoutMs: 6000,
      maxBytes: 512 * 1024,
      allowHosts: YAHOO_HOSTS,
      headers: { "User-Agent": "Mozilla/5.0 (Jarvis market-sync)" },
    });
    if (!r.ok) continue;
    try {
      const body = JSON.parse(new TextDecoder().decode(r.bytes));
      const results = body?.quoteResponse?.result;
      if (Array.isArray(results) && results.length > 0) return results as YahooQuoteResult[];
    } catch { /* fall through to next host */ }
  }
  return [];
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const rl = limiter.check(auth.userId);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    const results = await fetchQuotes(TRACKED.map((t) => t.symbol));
    if (results.length === 0) {
      return new Response(JSON.stringify({ error: "yahoo_unreachable" }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const bySymbol = new Map(results.map((r) => [r.symbol, r]));
    const now = new Date().toISOString();
    const rows = TRACKED
      .map((t) => {
        const q = bySymbol.get(t.symbol);
        if (!q || typeof q.regularMarketPrice !== "number") return null;
        return {
          symbol: t.symbol,
          name: t.name,
          kind: t.kind,
          currency: t.currency,
          price: q.regularMarketPrice,
          change_abs: q.regularMarketChange ?? null,
          change_pct: q.regularMarketChangePercent ?? null,
          source: "yahoo",
          fetched_at: now,
          updated_at: now,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: "no_quotes_returned" }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const { error } = await supabase.from("market_quotes").upsert(rows, { onConflict: "symbol" });
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true, synced: rows.length }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Market sync failed", "finance-market-sync", cors);
  }
});