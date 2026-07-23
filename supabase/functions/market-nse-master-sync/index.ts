// market-nse-master-sync — pull the official NSE equity master (EQUITY_L.csv)
// and expand market_stocks + market_nse_master to the full active NSE universe
// (EQ/BE/BZ/SM/ST/SME series). Tickertape screens against this same set.
//
// Sources, in order:
//   1) EQUITY_L.csv     — NSE main-board master (EQ/BE/BZ series, ~2,400 rows).
//   2) SME_EQUITY_L.csv — NSE emerge SME master. Best-effort: NSE has moved
//      this path several times; multiple candidate URLs are tried and any
//      that returns a real CSV is merged in.
//   3) bhavcopy fallback — any symbol that traded on NSE in the last 5
//      sessions (via public.market_eod_nse) but is missing from
//      market_stocks is auto-seeded with is_active=true, in_universe=true.
//      Safety net so the tradable universe always covers what the daily
//      bhavcopy actually contains — especially SME rows the master CSV
//      endpoints may fail to surface.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { nseFetch } from "../_shared/market/nseClient.ts";

const EQUITY_L_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv";
const SME_EQUITY_L_URLS = [
  "https://nsearchives.nseindia.com/content/equities/SME_EQUITY_L.csv",
  "https://archives.nseindia.com/content/equities/SME_EQUITY_L.csv",
  "https://nsearchives.nseindia.com/emerge/content/equities/SME_EQUITY_L.csv",
];

// Series accepted into the tradable universe. SM/ST/SME cover NSE emerge.
const TRADABLE_SERIES = new Set(["EQ", "BE", "BZ", "SM", "ST", "SME", "SME_EQ"]);

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

async function fetchCsv(url: string): Promise<string | null> {
  try {
    const r = await nseFetch(url, { Accept: "text/csv,*/*" }, 20000);
    if (!r || !r.ok) return null;
    const text = await r.text();
    // Some NSE endpoints return an HTML "Resource not found" placeholder with
    // a 200 status; reject anything that isn't a real CSV header.
    if (!/^\s*SYMBOL/i.test(text)) return null;
    return text;
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

    const started = Date.now();

    // 1) Main-board master.
    const mainCsv = await fetchCsv(EQUITY_L_URL);
    if (!mainCsv) {
      return new Response(JSON.stringify({ error: "nse_master_fetch_failed" }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const parsed = parseCsv(mainCsv);

    // 2) SME master (best-effort: try each candidate URL until one works).
    let smeCount = 0;
    for (const smeUrl of SME_EQUITY_L_URLS) {
      const smeCsv = await fetchCsv(smeUrl);
      if (!smeCsv) continue;
      const smeParsed = parseCsv(smeCsv);
      if (smeParsed.length < 5) continue; // guard against stub responses
      parsed.push(...smeParsed);
      smeCount = smeParsed.length;
      break;
    }

    // Row columns: SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING,
    // PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE.
    const masterRows: any[] = [];
    const stockRows: any[] = [];
    const seenSymbol = new Set<string>();
    for (const row of parsed) {
      const symbol = row["SYMBOL"];
      const series = (row["SERIES"] || "").toUpperCase();
      if (!symbol || seenSymbol.has(symbol)) continue;
      seenSymbol.add(symbol);
      const company = row["NAME OF COMPANY"] || null;
      const isin = row["ISIN NUMBER"] || null;
      const faceValue = Number(row["FACE VALUE"]) || null;
      const listingDate = toIso(row["DATE OF LISTING"]);
      masterRows.push({
        symbol, isin, company_name: company, series, face_value: faceValue,
        listing_date: listingDate, is_active: true, fetched_at: new Date().toISOString(),
      });
      if (TRADABLE_SERIES.has(series)) {
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

    // 3) Bhavcopy fallback — any symbol that has traded on NSE in the last
    // 5 sessions but is missing from market_stocks. Guarantees the tradable
    // universe covers everything the daily bhavcopy actually shows.
    let seededFromBhavcopy = 0;
    try {
      const since = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
      const { data: bhav } = await supabase
        .from("market_eod_nse")
        .select("symbol, series")
        .gte("trade_date", since);
      const known = new Set<string>();
      const { data: knownRows } = await supabase
        .from("market_stocks")
        .select("symbol")
        .eq("exchange", "NSE");
      for (const r of knownRows ?? []) known.add((r as any).symbol);

      const toSeed = new Map<string, { symbol: string; series: string }>();
      for (const r of bhav ?? []) {
        const sym = (r as any).symbol as string;
        const series = ((r as any).series || "EQ").toUpperCase();
        if (!sym || known.has(sym) || toSeed.has(sym)) continue;
        if (!TRADABLE_SERIES.has(series)) continue;
        toSeed.set(sym, { symbol: sym, series });
      }
      const seedRows = [...toSeed.values()].map((r) => ({
        symbol: r.symbol, exchange: "NSE", series: r.series,
        instrument_type: "EQ", is_active: true, in_universe: true,
        yahoo_symbol: `${r.symbol}.NS`,
      }));
      for (let i = 0; i < seedRows.length; i += 500) {
        const chunk = seedRows.slice(i, i + 500);
        const { error } = await supabase.from("market_stocks").upsert(chunk, { onConflict: "symbol,exchange" });
        if (!error) seededFromBhavcopy += chunk.length;
      }
    } catch { /* non-fatal */ }

    await supabase.from("market_ingestion_runs").insert({
      source: "nse_master", stage: "fetch", status: "ok",
      rows_ingested: masterUpserted, duration_ms: Date.now() - started,
      metadata: { stocks_upserted: stocksUpserted, sme_rows: smeCount, seeded_from_bhavcopy: seededFromBhavcopy },
      finished_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({
      ok: true,
      master_rows: masterUpserted,
      stocks_rows: stocksUpserted,
      sme_rows: smeCount,
      seeded_from_bhavcopy: seededFromBhavcopy,
      parsed: parsed.length,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
