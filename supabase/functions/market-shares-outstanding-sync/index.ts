// market-shares-outstanding-sync — populate market_shares_outstanding by
// reading `issuedSize` from NSE quote-equity for each active NSE equity.
// Chunked, resumable: only refreshes rows older than 7 days per run.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { nseFetch } from "../_shared/market/nseClient.ts";

const CHUNK = 60;
const CONCURRENCY = 4;

async function fetchIssuedSize(symbol: string): Promise<number | null> {
  const url = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`;
  const r = await nseFetch(url, { Accept: "application/json,text/plain,*/*" }, 8000);
  if (!r || !r.ok) return null;
  try {
    const body = await r.json();
    const raw = body?.securityInfo?.issuedSize ?? body?.metadata?.issuedSize ?? body?.securityInfo?.issuedCap;
    const n = typeof raw === "string" ? Number(raw.replace(/,/g, "")) : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

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

    // Claim symbols whose shares row is missing or older than 7 days.
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data: stocks, error } = await supabase.rpc("claim_market_fundamentals_sync", { _limit: CHUNK }).select();
    // fallback: raw claim by joining on missing shares
    let workList: any[] = [];
    if (error || !stocks) {
      const { data } = await supabase
        .from("market_stocks")
        .select("symbol")
        .eq("is_active", true).eq("exchange", "NSE")
        .limit(CHUNK);
      workList = (data ?? []) as any[];
    } else {
      workList = stocks as any[];
    }

    // Filter out symbols already refreshed within 7d.
    const symbols = workList.map((s: any) => s.symbol);
    const { data: existing } = await supabase
      .from("market_shares_outstanding")
      .select("symbol,as_of")
      .in("symbol", symbols);
    const fresh = new Set((existing ?? []).filter((r: any) => r.as_of >= cutoff.slice(0, 10)).map((r: any) => r.symbol));
    const work = workList.filter((s: any) => !fresh.has(s.symbol));

    let synced = 0, failed = 0;
    const started = Date.now();
    const asOf = new Date().toISOString().slice(0, 10);

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const s = work.shift();
        if (!s) break;
        const totalShares = await fetchIssuedSize(s.symbol);
        if (totalShares == null) { failed++; continue; }
        const { error: upErr } = await supabase.from("market_shares_outstanding").upsert({
          symbol: s.symbol, as_of: asOf, total_shares: totalShares,
          source: "nse", fetched_at: new Date().toISOString(),
        }, { onConflict: "symbol,as_of" });
        if (upErr) failed++; else synced++;
      }
    });
    await Promise.all(workers);

    await supabase.from("market_ingestion_runs").insert({
      source: "nse_shares_outstanding", stage: "fetch",
      status: failed > synced ? "partial" : "ok",
      rows_ingested: synced, duration_ms: Date.now() - started,
      metadata: { failed, attempted: symbols.length, skipped_fresh: symbols.length - work.length },
      finished_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({
      ok: true, attempted: symbols.length, synced, failed,
      skipped_fresh: symbols.length - work.length,
      drained: work.length === 0 && workList.length < CHUNK,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
