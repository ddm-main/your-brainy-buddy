// market-nse-master-sync — pull the official NSE equity master (EQUITY_L.csv)
// and expand market_stocks + market_nse_master to the full active NSE universe
// (EQ/BE/BZ/SM/ST/SME series). Tickertape screens against this same set.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { nseFetch } from "../_shared/market/nseClient.ts";

const EQUITY_L_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv";

function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toUpperCase());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 2) continue;
    const row: Record<string, string> = {};
    header.forEach((h, idx) => { row[h] = (cols[idx] ?? "").trim().replace(/^"|"$/g, ""); });
    out.push(row);
  }
  return out;
}

function toIso(nseDate: string): string | null {
  if (!nseDate) return null;
  const d = new Date(nseDate);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
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

    const started = Date.now();
    const r = await nseFetch(EQUITY_L_URL, { Accept: "text/csv,*/*" }, 20000);
    if (!r || !r.ok) {
      return new Response(JSON.stringify({ error: "nse_master_fetch_failed", status: r?.status ?? 0 }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const csv = await r.text();
    const parsed = parseCsv(csv);

    // Row columns: SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING,
    // PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE.
    const masterRows: any[] = [];
    const stockRows: any[] = [];
    for (const row of parsed) {
      const symbol = row["SYMBOL"];
      const series = row["SERIES"];
      if (!symbol) continue;
      const company = row["NAME OF COMPANY"] || null;
      const isin = row["ISIN NUMBER"] || null;
      const faceValue = Number(row["FACE VALUE"]) || null;
      const listingDate = toIso(row["DATE OF LISTING"]);
      masterRows.push({
        symbol, isin, company_name: company, series, face_value: faceValue,
        listing_date: listingDate, is_active: true, fetched_at: new Date().toISOString(),
      });
      // Only equity-like series enter the tradable universe.
      if (["EQ","BE","BZ","SM","ST","SME"].includes(series)) {
        stockRows.push({
          symbol, exchange: "NSE",
          company_name: company, series, isin,
          yahoo_symbol: `${symbol}.NS`,
          instrument_type: "EQ",
          is_active: true, in_universe: true,
        });
      }
    }

    let masterUpserted = 0, stocksUpserted = 0;
    for (let i = 0; i < masterRows.length; i += 500) {
      const chunk = masterRows.slice(i, i + 500);
      const { error } = await supabase.from("market_nse_master").upsert(chunk, { onConflict: "symbol" });
      if (!error) masterUpserted += chunk.length;
    }
    for (let i = 0; i < stockRows.length; i += 500) {
      const chunk = stockRows.slice(i, i + 500);
      const { error } = await supabase.from("market_stocks").upsert(chunk, { onConflict: "symbol,exchange" });
      if (!error) stocksUpserted += chunk.length;
    }

    await supabase.from("market_ingestion_runs").insert({
      source: "nse_master", stage: "fetch", status: "ok",
      rows_ingested: masterUpserted, duration_ms: Date.now() - started,
      metadata: { stocks_upserted: stocksUpserted },
      finished_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({
      ok: true, master_rows: masterUpserted, stocks_rows: stocksUpserted, parsed: parsed.length,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
