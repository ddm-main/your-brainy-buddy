// market-shares-outstanding-sync — populate market_shares_outstanding by
// reading `issuedSize` from NSE quote-equity for each active NSE equity,
// with a Yahoo `defaultKeyStatistics.sharesOutstanding` fallback for symbols
// NSE refuses. Chunked, resumable: only refreshes rows older than 7 days.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { nseFetch } from "../_shared/market/nseClient.ts";
import { fmpProfile } from "../_shared/market/fmpClient.ts";

const CHUNK = 120;
const CONCURRENCY = 4;

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

async function fetchYahooShares(symbol: string): Promise<number | null> {
  // v10/quoteSummary now requires a crumb; v7/quote does not and returns
  // sharesOutstanding directly. Try .NS first, then .BO.
  const suffixes = [".NS", ".BO"];
  for (const suf of suffixes) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol + suf)}`;
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Jarvis shares-sync)", Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const body = await r.json();
      const q = body?.quoteResponse?.result?.[0];
      const raw = q?.sharesOutstanding;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* try next suffix */ }
  }
  return null;
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

    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
    // Pull a wider candidate pool, then subtract symbols already refreshed
    // within 7d. Prioritizes symbols with NO row first, then oldest as_of.
    const { data: candidatePool } = await supabase
      .from("market_stocks")
      .select("symbol")
      .eq("is_active", true).eq("exchange", "NSE")
      .order("symbol")
      .limit(2000);
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

    let nseHits = 0, yahooHits = 0, fmpHits = 0, failed = 0;
    const started = Date.now();
    const asOf = new Date().toISOString().slice(0, 10);
    const fmpKeyPresent = !!Deno.env.get("FINANCIAL_MODELING_PREP_API_KEY");

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const s = work.shift();
        if (!s) break;
        let totalShares = await fetchIssuedSize(s.symbol);
        let source: "nse" | "yahoo" | "fmp" = "nse";
        if (totalShares == null) {
          await sleep(200 + Math.random() * 200);
          totalShares = await fetchYahooShares(s.symbol);
          source = "yahoo";
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
        if (source === "nse") nseHits++;
        else if (source === "yahoo") yahooHits++;
        else fmpHits++;
        // Gentle jitter to avoid Akamai / Yahoo rate limits.
        await sleep(150 + Math.random() * 250);
      }
    });
    await Promise.all(workers);

    const synced = nseHits + yahooHits + fmpHits;
    await supabase.from("market_ingestion_runs").insert({
      source: "nse_shares_outstanding", stage: "fetch",
      status: failed > synced ? "partial" : "ok",
      rows_ingested: synced, duration_ms: Date.now() - started,
      metadata: { failed, attempted, skipped_fresh: skippedFresh, nse: nseHits, yahoo: yahooHits, fmp: fmpHits },
      finished_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({
      ok: true, attempted, synced, failed,
      skipped_fresh: skippedFresh, nse: nseHits, yahoo: yahooHits, fmp: fmpHits,
      drained: attempted < CHUNK,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
