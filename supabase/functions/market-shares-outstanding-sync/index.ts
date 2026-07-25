// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-shares-outstanding-sync — populate market_shares_outstanding.
// Waterfall (Tickertape parity): Yahoo v10 quoteSummary (crumb-authenticated)
// → NSE quote-equity issuedSize → FMP profile. Yahoo is primary because NSE's
// endpoint frequently 401/blocks non-browser callers on Supabase edge IPs,
// which is why market_shares_outstanding was sitting at 0 rows.
// Kotak Neo isn't in the chain — the /quote payload doesn't expose shares
// outstanding, so this stays vendor-only regardless of the user's broker.
// Chunked, resumable: skips rows refreshed within 7 days.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { nseFetch } from "../_shared/market/nseClient.ts";
import { fmpProfile } from "../_shared/market/fmpClient.ts";
import { yahooQuoteSummary } from "../_shared/market/yahooCrumb.ts";
import { toYahooSymbol } from "../_shared/market/yahooClient.ts";

// CHUNK sized to drain the ~1600 outstanding rows in a couple of orchestrator
// iterations without exceeding edge worker CPU time. REFRESH_DAYS at 7 keeps
// re-scrapes weekly (shares outstanding only changes on corporate actions).
const CHUNK = 1600;
const CONCURRENCY = 8;
const REFRESH_DAYS = 7;

async function fetchYahooShares(symbol: string, exchange = "NSE"): Promise<number | null> {
  // Try the stock's exchange first, then swap suffix as a fallback.
  const primary = toYahooSymbol(symbol, exchange);
  const alt = primary.endsWith(".NS") ? `${symbol}.BO` : `${symbol}.NS`;
  for (const y of [primary, alt]) {
    try {
      const r = await yahooQuoteSummary(y, "defaultKeyStatistics,price");
      const raw = r?.defaultKeyStatistics?.sharesOutstanding?.raw
        ?? r?.price?.sharesOutstanding?.raw;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* try next */ }
  }
  return null;
}

async function fetchIssuedSize(symbol: string): Promise<number | null> {
  const url = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`;
  const r = await nseFetch(url, {
    Accept: "application/json,text/plain,*/*",
    Referer: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`,
  }, 12000);
  if (!r || !r.ok) return null;
  try {
    const body = await r.json();
    const raw = body?.securityInfo?.issuedSize ?? body?.metadata?.issuedSize ?? body?.securityInfo?.issuedCap;
    const n = typeof raw === "string" ? Number(raw.replace(/,/g, "")) : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

async function fetchFmpShares(symbol: string): Promise<number | null> {
  try {
    const p = await fmpProfile(symbol, "NSE");
    if (!p) return null;
    // fmpProfile returns shares_outstanding in Crores; convert back to units.
    return p.shares_outstanding != null ? p.shares_outstanding * 1e7 : null;
  } catch { return null; }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    const cronSecret = Deno.env.get("CRON_SECRET");
    const hdr = req.headers.get("x-cron-secret");
    const authHdr = req.headers.get("authorization");
    const isCron = cronSecret && hdr && hdr === cronSecret;
    if (!isCron && !authHdr) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const cutoff = new Date(Date.now() - REFRESH_DAYS * 86400_000).toISOString();
    const { data: candidatePool } = await supabase
      .from("market_stocks")
      .select("symbol")
      .eq("is_active", true).eq("exchange", "NSE")
      .order("symbol")
      .limit(3000);
    const poolSymbols = (candidatePool ?? []).map((s: any) => s.symbol);

    const cutoffDate = cutoff.slice(0, 10);
    const { data: existing } = await supabase
      .from("market_shares_outstanding")
      .select("symbol,as_of")
      .in("symbol", poolSymbols);
    const fresh = new Set((existing ?? []).filter((r: any) => r.as_of >= cutoffDate).map((r: any) => r.symbol));
    const work = poolSymbols
      .filter((s: string) => !fresh.has(s))
      .slice(0, CHUNK)
      .map((symbol: string) => ({ symbol }));
    const attempted = work.length;
    const skippedFresh = poolSymbols.length - work.length;

    let yahooHits = 0, nseHits = 0, fmpHits = 0, failed = 0;
    const started = Date.now();
    const asOf = new Date().toISOString().slice(0, 10);
    const fmpKeyPresent = !!Deno.env.get("FINANCIAL_MODELING_PREP_API_KEY");

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const s = work.shift();
        if (!s) break;
        // Yahoo first — it works from Supabase edges; NSE frequently doesn't.
        let totalShares = await fetchYahooShares(s.symbol, "NSE");
        let source: "yahoo" | "nse" | "fmp" = "yahoo";
        if (totalShares == null) {
          totalShares = await fetchIssuedSize(s.symbol);
          source = "nse";
        }
        if (totalShares == null && fmpKeyPresent) {
          totalShares = await fetchFmpShares(s.symbol);
          source = "fmp";
        }
        if (totalShares == null) { failed++; continue; }
        const { error: upErr } = await supabase.from("market_shares_outstanding").upsert({
          symbol: s.symbol, as_of: asOf, total_shares: totalShares,
          source, fetched_at: new Date().toISOString(),
        }, { onConflict: "symbol,as_of" });
        if (upErr) { failed++; continue; }
        if (source === "yahoo") yahooHits++;
        else if (source === "nse") nseHits++;
        else fmpHits++;
        // Snapshot onto market_stocks so Screener MCap renders instantly.
        const totalCr = totalShares / 1e7;
        const { data: last } = await supabase
          .from("market_daily_prices")
          .select("close").eq("symbol", s.symbol).eq("exchange", "NSE")
          .order("trade_date", { ascending: false }).limit(1).maybeSingle();
        const close = last?.close != null ? Number(last.close) : null;
        const mcap = close != null && Number.isFinite(close) ? close * totalCr : null;
        await supabase.from("market_stocks").update({
          total_shares_cr: totalCr,
          shares_source: source,
          shares_as_of: new Date().toISOString(),
          market_cap: mcap,
          market_cap_calc_at: mcap != null ? new Date().toISOString() : null,
          market_cap_source: mcap != null ? `calc:${source}_shares_x_close` : null,
          market_cap_as_of:  mcap != null ? new Date().toISOString() : null,
        }).eq("symbol", s.symbol).eq("exchange", "NSE");
        // Gentle jitter to stay under Yahoo/Akamai rate limits.
        await sleep(150 + Math.random() * 250);
      }
    });
    await Promise.all(workers);

    const synced = yahooHits + nseHits + fmpHits;
    await supabase.from("market_ingestion_runs").insert({
      source: "shares_outstanding_waterfall", stage: "fetch",
      status: failed > synced ? "partial" : "ok",
      rows_ingested: synced, duration_ms: Date.now() - started,
      metadata: { failed, attempted, skipped_fresh: skippedFresh, yahoo: yahooHits, nse: nseHits, fmp: fmpHits },
      finished_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({
      ok: true, attempted, synced, failed,
      skipped_fresh: skippedFresh, yahoo: yahooHits, nse: nseHits, fmp: fmpHits,
      drained: attempted < CHUNK,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
