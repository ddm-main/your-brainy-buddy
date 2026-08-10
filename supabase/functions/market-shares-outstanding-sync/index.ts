// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-shares-outstanding-sync — populate market_shares_outstanding.
// Waterfall (Tickertape parity): Yahoo v10 quoteSummary (crumb-authenticated)
// → NSE quote-equity issuedSize → FMP profile. Yahoo is primary because NSE's
// endpoint frequently 401/blocks non-browser callers on Supabase edge IPs,
// which is why market_shares_outstanding was sitting at 0 rows.
// Kotak Neo isn't in the chain — the /quote payload doesn't expose shares
// outstanding, so this stays vendor-only regardless of the user's broker.
// Chunked, resumable: skips rows refreshed within 7 days.
//
// TWO BUGS FIXED 2026-07-28 (both made this look like a "100% failure rate"):
//
//  1. UNIVERSE TRUNCATION. The candidate query used `.limit(3000)`, but the
//     Data API caps every response at 1000 rows — silently, with no error.
//     So the job only ever saw the first 1000 symbols alphabetically and had
//     literally never attempted the 1,638 symbols sorting after "HONAUT".
//     Coverage was stuck at 909/2547 and could never improve. Now paged via
//     fetchAllRows().
//  2. NO FAILURE BACKOFF. The ~91 symbols that no provider covers (fresh
//     listings, SME scrips, renamed tickers) were re-attempted on every run
//     every 20 minutes, forever — 3 upstream calls each, all doomed, and they
//     were the *only* thing the job ever reported on. Attempts are now
//     recorded on market_stocks and hard failures are parked for 7 days.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { nseFetch } from "../_shared/market/nseClient.ts";
import { fmpProfile } from "../_shared/market/fmpClient.ts";
import { yahooQuoteSummary } from "../_shared/market/yahooCrumb.ts";
import { toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { chunked, fetchAllRows } from "../_shared/market/paginate.ts";

// CHUNK is the per-invocation work budget; the orchestrator drains by calling
// repeatedly until `drained: true`. REFRESH_DAYS at 7 keeps re-scrapes weekly
// (shares outstanding only changes on corporate actions).
const CHUNK = 400;
const CONCURRENCY = 8;
const REFRESH_DAYS = 7;
// After this many consecutive whole-waterfall failures a symbol is parked and
// only re-probed once the park window expires.
const MAX_ATTEMPTS = 3;
const PARK_DAYS = 7;

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

type Candidate = {
  symbol: string;
  shares_sync_attempts: number | null;
  shares_sync_attempted_at: string | null;
};

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    // Cron callers are verified against the Vault-held secret (requireCronSecret
    // returns null on a match); authenticated users can also trigger this.
    const authHdr = req.headers.get("authorization");
    const isCron = req.headers.get("x-cron-secret")
      ? (await requireCronSecret(req)) === null
      : false;
    if (!isCron && !authHdr) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const cutoffDate = new Date(Date.now() - REFRESH_DAYS * 86400_000).toISOString().slice(0, 10);
    const parkCutoff = new Date(Date.now() - PARK_DAYS * 86400_000).toISOString();

    // FULL universe — paged, because the Data API caps each response at 1000.
    const pool = await fetchAllRows<Candidate>((from, to) =>
      supabase
        .from("market_stocks")
        .select("symbol,shares_sync_attempts,shares_sync_attempted_at")
        .eq("is_active", true).eq("exchange", "NSE")
        // Penny-excluded names are out of the universe; their share counts are
        // never read and market_shares_outstanding rejects their rows anyway.
        .not("penny_excluded", "is", true)
        .order("symbol")
        .range(from, to) as any,
    );

    // Which symbols already have a recent reading? Also paged, and the `.in()`
    // list is chunked so the request line can't overflow.
    const fresh = new Set<string>();
    for (const batch of chunked(pool.map((p) => p.symbol), 200)) {
      const rows = await fetchAllRows<{ symbol: string; as_of: string }>((from, to) =>
        supabase
          .from("market_shares_outstanding")
          .select("symbol,as_of")
          .in("symbol", batch)
          .gte("as_of", cutoffDate)
          .order("symbol")
          .range(from, to) as any,
      );
      for (const r of rows) fresh.add(r.symbol);
    }

    const parked: string[] = [];
    const eligible = pool.filter((c) => {
      if (fresh.has(c.symbol)) return false;
      const attempts = c.shares_sync_attempts ?? 0;
      if (attempts >= MAX_ATTEMPTS) {
        // Park until the window expires, then let it re-probe once.
        if (!c.shares_sync_attempted_at || c.shares_sync_attempted_at > parkCutoff) {
          parked.push(c.symbol);
          return false;
        }
      }
      return true;
    });

    // Never-attempted symbols first, then least-recently-attempted. This is
    // what finally drags the alphabetical tail of the universe into coverage.
    eligible.sort((a, b) => {
      const aa = a.shares_sync_attempts ?? 0, ba = b.shares_sync_attempts ?? 0;
      if (aa !== ba) return aa - ba;
      const at = a.shares_sync_attempted_at ?? "", bt = b.shares_sync_attempted_at ?? "";
      return at < bt ? -1 : at > bt ? 1 : 0;
    });

    const work = eligible.slice(0, CHUNK);
    const attempted = work.length;
    const remaining = eligible.length - attempted;

    let yahooHits = 0, nseHits = 0, fmpHits = 0, failed = 0;
    const failedSymbols: string[] = [];

    // EGRESS: the last close used to be read one row at a time inside the loop
    // (one PostgREST round-trip per symbol). One batched RPC covers the chunk.
    const closes = new Map<string, number>();
    {
      const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
      for (const batch of chunked(work.map((w) => w.symbol), 200)) {
        const { data } = await supabase.rpc("market_live_settled_anchors_lean", {
          _symbols: batch, _before: tomorrow,
        });
        for (const r of (data ?? []) as Array<{ symbol: string; prev_close: number | string }>) {
          const v = Number(r.prev_close);
          if (Number.isFinite(v) && v > 0) closes.set(String(r.symbol), v);
        }
      }
    }

    const started = Date.now();
    const asOf = new Date().toISOString().slice(0, 10);
    const nowIso = new Date().toISOString();
    const fmpKeyPresent = !!Deno.env.get("FINANCIAL_MODELING_PREP_API_KEY");

    const queue = [...work];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        // Stay inside the edge worker CPU/wall budget; the orchestrator will
        // call us again for whatever is left rather than dying mid-chunk.
        if (Date.now() - started > 100_000) break;
        const s = queue.shift();
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

        if (totalShares == null) {
          failed++;
          if (failedSymbols.length < 50) failedSymbols.push(s.symbol);
          // Record the attempt so this symbol drifts to the back of the queue
          // and eventually parks, instead of being retried every 20 minutes.
          await supabase.from("market_stocks").update({
            shares_sync_attempts: (s.shares_sync_attempts ?? 0) + 1,
            shares_sync_attempted_at: nowIso,
          }).eq("symbol", s.symbol).eq("exchange", "NSE");
          continue;
        }

        const { error: upErr } = await supabase.from("market_shares_outstanding").upsert({
          symbol: s.symbol, as_of: asOf, total_shares: totalShares,
          source, fetched_at: nowIso,
        }, { onConflict: "symbol,as_of" });
        if (upErr) {
          failed++;
          if (failedSymbols.length < 50) failedSymbols.push(`${s.symbol}(db)`);
          continue;
        }
        if (source === "yahoo") yahooHits++;
        else if (source === "nse") nseHits++;
        else fmpHits++;

        // Snapshot onto market_stocks so Screener MCap renders instantly.
        const totalCr = totalShares / 1e7;
        const close = closes.get(s.symbol) ?? null;
        const mcap = close != null && Number.isFinite(close) ? close * totalCr : null;

        await supabase.from("market_stocks").update({
          total_shares_cr: totalCr,
          shares_source: source,
          shares_as_of: nowIso,
          market_cap: mcap,
          market_cap_calc_at: mcap != null ? nowIso : null,
          market_cap_source: mcap != null ? `calc:${source}_shares_x_close` : null,
          market_cap_as_of:  mcap != null ? nowIso : null,
          // Success clears the failure streak.
          shares_sync_attempts: 0,
          shares_sync_attempted_at: nowIso,
        }).eq("symbol", s.symbol).eq("exchange", "NSE");
        // Gentle jitter to stay under Yahoo/Akamai rate limits.
        await sleep(150 + Math.random() * 250);
      }
    });
    await Promise.all(workers);

    const synced = yahooHits + nseHits + fmpHits;
    const leftover = remaining + queue.length;
    await supabase.from("market_ingestion_runs").insert({
      source: "shares_outstanding_waterfall", stage: "fetch",
      status: attempted === 0 ? "ok" : failed > synced ? "partial" : "ok",
      rows_ingested: synced, duration_ms: Date.now() - started,
      metadata: {
        failed, attempted, universe: pool.length,
        skipped_fresh: fresh.size, parked: parked.length, remaining: leftover,
        yahoo: yahooHits, nse: nseHits, fmp: fmpHits,
        failed_symbols: failedSymbols,
      },
      finished_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({
      ok: true, universe: pool.length, attempted, synced, failed,
      skipped_fresh: fresh.size, parked: parked.length, remaining: leftover,
      yahoo: yahooHits, nse: nseHits, fmp: fmpHits,
      drained: leftover === 0,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
