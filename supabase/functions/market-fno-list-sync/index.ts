// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-fno-list-sync — download NSE F&O market lots CSV and flip
// `fno_enabled` on market_stocks. Weekly cron; also runnable from MarketConfig.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { nseFetch } from "../_shared/market/nseClient.ts";

// NSE moved archives to nsearchives.* in 2025; the legacy /archives.* URL
// now 301-redirects to a circular PDF, not the CSV.
const FO_MKTLOTS_URL = "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv";

function extractSymbols(csv: string): string[] {
  const lines = csv.split(/\r?\n/);
  const out = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    // Format is roughly: "SR. NO., UNDERLYING, SYMBOL, ...expiry columns..."
    // Symbol is the 3rd column. Skip header + section rows.
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length < 2) continue;
    // Layout: "UNDERLYING, SYMBOL, <expiry lot columns...>"
    const sym = cols[1];
    if (!sym || /^[a-z]/i.test(sym) === false) continue;
    if (/^(symbol|underlying)$/i.test(sym)) continue;
    // Drop indices — we only flip fno_enabled on individual equities.
    if (/^NIFTY|^BANKNIFTY|^FINNIFTY|^MIDCPNIFTY/i.test(sym)) continue;
    if (!/^[A-Z0-9&-]+$/.test(sym)) continue;
    out.add(sym.toUpperCase());
  }
  return Array.from(out);
}

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

    const started = Date.now();
    const r = await nseFetch(FO_MKTLOTS_URL, { Accept: "text/csv,*/*" }, 15000);
    if (!r || !r.ok) {
      return new Response(JSON.stringify({ error: "fno_fetch_failed", status: r?.status ?? 0 }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const csv = await r.text();
    const symbols = extractSymbols(csv);
    if (symbols.length === 0) {
      return new Response(JSON.stringify({ error: "no_symbols_parsed" }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Clear existing flags, then flip on for the current F&O list.
    await supabase.from("market_stocks").update({ fno_enabled: false })
      .eq("fno_enabled", true);

    let flipped = 0;
    for (let i = 0; i < symbols.length; i += 200) {
      const slice = symbols.slice(i, i + 200);
      const { error, count } = await supabase.from("market_stocks")
        .update({ fno_enabled: true }, { count: "exact" })
        .in("symbol", slice).eq("exchange", "NSE");
      if (!error) flipped += count ?? slice.length;
    }

    await supabase.from("market_ingestion_runs").insert({
      source: "nse_fno_lots", stage: "fetch", status: "ok",
      rows_ingested: flipped, duration_ms: Date.now() - started,
      metadata: { csv_symbols: symbols.length },
      finished_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ ok: true, symbols: symbols.length, flipped }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});