// NSE bhavcopy sync — authoritative EOD source for Indian equities.
// Fetches the daily equity bhavcopy from NSE archives (free, no key) and
// upserts into public.market_eod_nse. Falls back through recent dates when
// the requested date has no file yet (weekends, holidays, delayed publish).
//
// Also computes source_hash per row and writes a ticker_trace entry per
// (symbol, trade_date, "nse_fetch") plus a summary market_ingestion_runs.
//
// Auth: requires x-cron-secret OR service-role (invoked from Config page
// which passes the user JWT; we accept authenticated users too).

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { nseFetch } from "../_shared/market/nseClient.ts";

const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Jarvis market-sync)",
  "Accept": "text/csv,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function fmtArchiveDate(d: Date): string {
  // cm{DD}{MMM}{YYYY}bhav.csv (uppercase month) — legacy archives path
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mmm = MONTHS[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  return `${dd}${mmm}${yyyy}`;
}

function fmtIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// New NSE archive schema (post-2024): /content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip
// Old schema (pre-2024, still online for archives): /content/historical/EQUITIES/YYYY/MMM/cm{DD}{MMM}{YYYY}bhav.csv.zip
// SME emerge bhavcopy (separate segment, missing from CM bhavcopy): /content/sme/sme{DD}{MMM}{YYYY}bhav.csv.zip
function buildBhavcopyUrls(d: Date): string[] {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mmm = MONTHS[d.getUTCMonth()];
  const iso = `${yyyy}${mm}${dd}`;
  const legacy = fmtArchiveDate(d);
  return [
    `https://archives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${iso}_F_0000.csv.zip`,
    `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${iso}_F_0000.csv.zip`,
    `https://archives.nseindia.com/content/historical/EQUITIES/${yyyy}/${mmm}/cm${legacy}bhav.csv.zip`,
  ];
}

function buildSmeBhavcopyUrls(d: Date): string[] {
  const legacy = fmtArchiveDate(d);
  return [
    `https://nsearchives.nseindia.com/content/sme/sme${legacy}bhav.csv.zip`,
    `https://archives.nseindia.com/content/sme/sme${legacy}bhav.csv.zip`,
  ];
}


async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchZip(url: string): Promise<Uint8Array | null> {
  // NSE archives sits behind Akamai and 503s anonymous requests. Warm a
  // homepage cookie via the shared NSE session first.
  try {
    const r = await nseFetch(url, { Accept: "application/zip,application/octet-stream,*/*" }, 20000);
    if (!r || !r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch { return null; }
}

// Minimal unzip using Deno's std — we defer to a native-in-Deno unzip via
// the JSZip npm module which works in Deno-deploy environments.
async function unzipFirstCsv(zipBytes: Uint8Array): Promise<string | null> {
  const JSZip = (await import("npm:jszip@3.10.1")).default;
  const zip = await JSZip.loadAsync(zipBytes);
  for (const name of Object.keys(zip.files)) {
    if (name.toLowerCase().endsWith(".csv")) {
      return await zip.files[name].async("string");
    }
  }
  return null;
}

function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < header.length) continue;
    const row: Record<string, string> = {};
    header.forEach((h, idx) => { row[h] = (cols[idx] ?? "").trim(); });
    rows.push(row);
  }
  return rows;
}

// Map bhavcopy columns (both new + legacy schema) to our normalized shape.
function normalizeRow(r: Record<string, string>, tradeDateIso: string) {
  const symbol = (r["TckrSymb"] ?? r["SYMBOL"] ?? "").trim();
  const series = (r["SctySrs"] ?? r["SERIES"] ?? "").trim();
  const open = num(r["OpnPric"] ?? r["OPEN"]);
  const high = num(r["HghPric"] ?? r["HIGH"]);
  const low = num(r["LwPric"] ?? r["LOW"]);
  const close = num(r["ClsPric"] ?? r["CLOSE"]);
  const prevClose = num(r["PrvsClsgPric"] ?? r["PREVCLOSE"]);
  const volume = numInt(r["TtlTradgVol"] ?? r["TOTTRDQTY"]);
  const tradedValue = num(r["TtlTrfVal"] ?? r["TOTTRDVAL"]);
  return { symbol, exchange: "NSE", series, open, high, low, close, prev_close: prevClose, volume, traded_value: tradedValue, trade_date: tradeDateIso };
}

function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function numInt(v: string | undefined): number | null {
  const n = num(v);
  return n == null ? null : Math.round(n);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    // Auth: allow cron secret OR any authenticated user (Config page trigger)
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
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const requestedDate: string | undefined = body?.date;

    // Try the requested date, then walk back up to 5 days for weekends/holidays.
    const base = requestedDate ? new Date(requestedDate + "T00:00:00Z") : new Date();
    let csv: string | null = null;
    let tradeDate: Date | null = null;
    let sourceUrl: string | null = null;

    for (let back = 0; back < 6 && !csv; back++) {
      const d = new Date(base.getTime());
      d.setUTCDate(d.getUTCDate() - back);
      const urls = buildBhavcopyUrls(d);
      for (const u of urls) {
        const zip = await fetchZip(u);
        if (!zip) continue;
        try {
          const text = await unzipFirstCsv(zip);
          if (text && text.includes(",")) {
            csv = text;
            tradeDate = d;
            sourceUrl = u;
            break;
          }
        } catch { /* try next url */ }
      }
    }

    if (!csv || !tradeDate) {
      await supabase.from("market_ingestion_runs").insert({
        source: "nse_bhavcopy", stage: "fetch", status: "failed",
        error_message: "no bhavcopy found in last 6 days", finished_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
      });
      return new Response(JSON.stringify({ error: "bhavcopy_not_found" }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const tradeDateIso = fmtIsoDate(tradeDate);
    const parsed = parseCsv(csv);
    const rows: any[] = [];
    const trace: any[] = [];

    for (const r of parsed) {
      const norm = normalizeRow(r, tradeDateIso);
      if (!norm.symbol || norm.close == null) continue;
      // Skip non-equity series
      if (!["EQ","BE","BZ","SM","ST"].includes(norm.series)) continue;
      const hash = await sha256Hex([norm.symbol, tradeDateIso, norm.close, norm.volume].join("|"));
      rows.push({ ...norm, source: "nse_bhavcopy", source_hash: hash, fetched_at: new Date().toISOString() });
    }

    // 2) Best-effort SME emerge bhavcopy for the same trade date. SME rows
    // aren't in the CM bhavcopy, so without this the screener universe
    // silently drops NSE emerge stocks that Tickertape includes.
    let smeRows = 0;
    let smeSourceUrl: string | null = null;
    try {
      for (const u of buildSmeBhavcopyUrls(tradeDate)) {
        const zip = await fetchZip(u);
        if (!zip) continue;
        const smeCsv = await unzipFirstCsv(zip).catch(() => null);
        if (!smeCsv) continue;
        smeSourceUrl = u;
        const smeParsed = parseCsv(smeCsv);
        for (const r of smeParsed) {
          const norm = normalizeRow(r, tradeDateIso);
          if (!norm.symbol || norm.close == null) continue;
          const series = norm.series || "SM";
          if (!["SM","ST","SME","SME_EQ"].includes(series)) continue;
          const hash = await sha256Hex([norm.symbol, tradeDateIso, norm.close, norm.volume].join("|"));
          rows.push({ ...norm, series, source: "nse_bhavcopy_sme", source_hash: hash, fetched_at: new Date().toISOString() });
          smeRows++;
        }
        break;
      }
    } catch { /* non-fatal */ }

    // Batch upsert in chunks of 500
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await supabase.from("market_eod_nse").upsert(chunk, {
        onConflict: "symbol,exchange,trade_date",
      });
      if (error) throw error;
      inserted += chunk.length;
    }

    // Summary trace (bulk-write a compact summary row instead of per-symbol
    // trace to keep the table small; per-symbol trace can be added later).
    await supabase.from("market_ingestion_runs").insert({
      source: "nse_bhavcopy", stage: "fetch", status: "ok",
      trade_date: tradeDateIso,
      rows_ingested: inserted,
      duration_ms: Date.now() - started,
      metadata: { source_url: sourceUrl, sme_rows: smeRows, sme_source_url: smeSourceUrl },
      finished_at: new Date().toISOString(),
    });


    return new Response(JSON.stringify({
      ok: true, trade_date: tradeDateIso, rows: inserted, source_url: sourceUrl,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
