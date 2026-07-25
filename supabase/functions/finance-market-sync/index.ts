// Refreshes the shared public.market_quotes cache.
// Provider policy: Indian indices (Nifty/Sensex/Bank Nifty/India VIX) go
// through the caller's active market provider — Kotak Neo first when the
// user is connected (real-time), Yahoo per-symbol fallback (delayed) built
// into kotakProvider. Non-Indian instruments (US indices, FX, commodities,
// crypto) stay on Yahoo because Kotak Neo has no coverage for them.
// Rate-limited per user (1/5min) and safe to call opportunistically from
// the Intelligence page. Writes bypass RLS via service role; every
// authenticated user reads the same shared cache.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";
import { safeFetch } from "../_shared/http.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";


const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

// Symbol → (display name, kind, currency). Yahoo tickers are the display /
// storage key (market_quotes.symbol) so the client keeps rendering unchanged.
// `kotakKey` (when set) tells the Kotak-first path which NSE symbol to
// request; kotakProvider transparently falls back to Yahoo per-symbol when
// the instrument token isn't in market_stocks.
interface Tracked {
  symbol: string;
  name: string;
  kind: "index" | "fx" | "commodity" | "crypto";
  currency: string;
  kotakKey?: string; // "NSE:<symbol>" — only set for Kotak-eligible instruments
}
const TRACKED: Tracked[] = [
  { symbol: "^NSEI",   name: "Nifty 50",     kind: "index",     currency: "INR", kotakKey: "NSE:NIFTY" },
  { symbol: "^BSESN",  name: "Sensex",       kind: "index",     currency: "INR", kotakKey: "NSE:SENSEX" },
  { symbol: "^NSEBANK",name: "Bank Nifty",   kind: "index",     currency: "INR", kotakKey: "NSE:BANKNIFTY" },
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

    const now = new Date().toISOString();
    const rows: Array<Record<string, unknown>> = [];
    const kotakServed = new Set<string>(); // TRACKED.symbol values covered by Kotak-first path

    // --- Kotak-first path for Indian indices ---
    const kotakEligible = TRACKED.filter((t) => t.kotakKey);
    if (kotakEligible.length > 0) {
      try {
        const { provider } = await getActiveProvider(supabase, auth.userId);
        const quotes = await provider.getQuotes(kotakEligible.map((t) => t.kotakKey!));
        const byKey = new Map(quotes.map((q) => [q.key, q]));
        for (const t of kotakEligible) {
          const q = byKey.get(t.kotakKey!);
          if (!q || typeof q.price !== "number" || q.price <= 0) continue;
          rows.push({
            symbol: t.symbol,
            name: t.name,
            kind: t.kind,
            currency: t.currency,
            price: q.price,
            change_abs: q.change_abs ?? null,
            change_pct: q.change_pct ?? null,
            source: q.source, // "kotak" | "yahoo" | "cache"
            fetched_at: now,
            updated_at: now,
          });
          kotakServed.add(t.symbol);
        }
      } catch {
        // Fall through — anything Kotak didn't cover is fetched from Yahoo below.
      }
    }

    // --- Yahoo path for global instruments + any Indian index Kotak missed ---
    const yahooSymbols = TRACKED.filter((t) => !kotakServed.has(t.symbol)).map((t) => t.symbol);
    if (yahooSymbols.length > 0) {
      const results = await fetchQuotes(yahooSymbols);
      const bySymbol = new Map(results.map((r) => [r.symbol, r]));
      for (const t of TRACKED) {
        if (kotakServed.has(t.symbol)) continue;
        const q = bySymbol.get(t.symbol);
        if (!q || typeof q.regularMarketPrice !== "number") continue;
        rows.push({
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
        });
      }
    }

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: "no_quotes_returned" }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const { error } = await supabase.from("market_quotes").upsert(rows, { onConflict: "symbol" });
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true, synced: rows.length, kotak: kotakServed.size }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });

  } catch (err) {
    return sanitizedErrorResponse(err, "Market sync failed", "finance-market-sync", cors);
  }
});