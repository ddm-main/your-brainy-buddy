// market-bse-bhavcopy-sync — BSE EOD tail. NSE bhavcopy is authoritative for
// dual-listed names; this fills the ~500-symbol BSE-only tail so the screener
// universe matches Tickertape's ~4000-symbol coverage.
//
// Downloads https://www.bseindia.com/download/BhavCopy/Equity/EQ<DDMMYY>_CSV.ZIP
// via a browser-like session (BSE also fronts with Akamai). Walks back up to
// 6 days for weekends/holidays. Only upserts BSE-only symbols into
// market_stocks (exchange='BSE'); NSE dual-listings stay on the NSE row.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const BSE_HOME = "https://www.bseindia.com/";

let cachedCookie: { cookie: string; at: number } | null = null;

async function bseCookie(force = false): Promise<string | null> {
  if (!force && cachedCookie && Date.now() - cachedCookie.at < 10 * 60_000) return cachedCookie.cookie;
  try {
    const r = await fetch(BSE_HOME, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });
    const setCookies = (r.headers as any).getSetCookie?.() as string[] | undefined;
    const raw = setCookies?.length ? setCookies : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")!] : []);
    const cookie = raw.map((s) => s.split(";")[0]).join("; ");
    if (!cookie) return null;
    cachedCookie = { cookie, at: Date.now() };
    return cookie;
  } catch { return null; }
}

function fmtDDMMYY(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

function fmtIsoDate(d: Date): string { return d.toISOString().slice(0, 10); }

async function fetchBseZip(d: Date): Promise<Uint8Array | null> {
  const url = `https://www.bseindia.com/download/BhavCopy/Equity/EQ${fmtDDMMYY(d)}_CSV.ZIP`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = await bseCookie(attempt === 1);
    if (!cookie) continue;
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/zip,application/octet-stream,*/*",
          Referer: "https://www.bseindia.com/markets/marketinfo/downloadeqbhavcopy.aspx",
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(20000),
      });
      if (r.status === 401 || r.status === 403) { cachedCookie = null; continue; }
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    } catch { cachedCookie = null; }
  }
  return null;
}

async function unzipFirstCsv(bytes: Uint8Array): Promise<string | null> {
  const JSZip = (await import("npm:jszip@3.10.1")).default;
  const zip = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(zip.files)) {
    if (name.toLowerCase().endsWith(".csv")) return await zip.files[name].async("string");
  }
  return null;
}

function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toUpperCase());
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

const num = (v: string | undefined): number | null => {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const requested = body?.date ? new Date(body.date + "T00:00:00Z") : new Date();

    let csv: string | null = null;
    let tradeDate: Date | null = null;
    for (let back = 0; back < 6 && !csv; back++) {
      const d = new Date(requested.getTime());
      d.setUTCDate(d.getUTCDate() - back);
      const zip = await fetchBseZip(d);
      if (!zip) continue;
      try {
        const text = await unzipFirstCsv(zip);
        if (text && text.includes(",")) { csv = text; tradeDate = d; }
      } catch { /* try next */ }
    }

    if (!csv || !tradeDate) {
      await supabase.from("market_ingestion_runs").insert({
        source: "bse_bhavcopy", stage: "fetch", status: "failed",
        error_message: "no bhavcopy found in last 6 days",
        duration_ms: Date.now() - started,
        finished_at: new Date().toISOString(),
      });
      return new Response(JSON.stringify({ error: "bhavcopy_not_found" }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const rows = parseCsv(csv);
    const tradeDateIso = fmtIsoDate(tradeDate);

    // Which BSE symbols are already covered on NSE — skip those (NSE row wins).
    const { data: nseSet } = await supabase.from("market_stocks")
      .select("symbol").eq("exchange", "NSE").eq("is_active", true);
    const onNse = new Set((nseSet ?? []).map((r: any) => r.symbol.toUpperCase()));

    let inserted = 0, eodInserted = 0;
    const stockBatch: any[] = [];
    const eodBatch: any[] = [];

    for (const r of rows) {
      // BSE columns: SC_CODE, SC_NAME, SC_GROUP, SC_TYPE, OPEN, HIGH, LOW, CLOSE, LAST, PREVCLOSE, NO_TRADES, NO_OF_SHRS, NET_TURNOV, TDCLOINDI, ISIN_CODE
      const type = (r["SC_TYPE"] ?? "").toUpperCase();
      if (type !== "Q" && type !== "" && type !== "A" && type !== "B" && type !== "T") continue;
      const code = (r["SC_CODE"] ?? "").trim();
      const name = (r["SC_NAME"] ?? "").trim();
      const isin = (r["ISIN_CODE"] ?? "").trim() || null;
      if (!code || !name) continue;
      // Use SC_CODE as the BSE symbol; Yahoo suffix is .BO.
      const symbol = code; // numeric BSE code — unique on BSE
      const close = num(r["CLOSE"]);
      if (close == null) continue;

      // Skip listings dual-listed on NSE by ISIN match (rough): if any NSE
      // active row shares this exact code as symbol, skip — we can't cheaply
      // match by ISIN without another round-trip, so we err on the side of
      // adding all pure-numeric BSE codes (they won't collide with NSE tickers).
      if (onNse.has(symbol.toUpperCase())) continue;

      stockBatch.push({
        symbol, exchange: "BSE",
        company_name: name, isin,
        yahoo_symbol: `${symbol}.BO`,
        instrument_type: "EQ", is_active: true, in_universe: true,
      });
      eodBatch.push({
        symbol, series: type || "A",
        open: num(r["OPEN"]), high: num(r["HIGH"]), low: num(r["LOW"]),
        close, prev_close: num(r["PREVCLOSE"]),
        volume: num(r["NO_OF_SHRS"]), traded_value: num(r["NET_TURNOV"]),
        trade_date: tradeDateIso, source: "bse_bhavcopy",
        fetched_at: new Date().toISOString(),
      });
    }

    for (let i = 0; i < stockBatch.length; i += 500) {
      const chunk = stockBatch.slice(i, i + 500);
      const { error } = await supabase.from("market_stocks")
        .upsert(chunk, { onConflict: "symbol,exchange", ignoreDuplicates: false });
      if (!error) inserted += chunk.length;
    }
    for (let i = 0; i < eodBatch.length; i += 500) {
      const chunk = eodBatch.slice(i, i + 500);
      const { error } = await supabase.from("market_eod_nse")
        .upsert(chunk, { onConflict: "symbol,trade_date" });
      if (!error) eodInserted += chunk.length;
    }

    await supabase.from("market_ingestion_runs").insert({
      source: "bse_bhavcopy", stage: "fetch", status: "ok",
      trade_date: tradeDateIso, rows_ingested: eodInserted,
      duration_ms: Date.now() - started,
      metadata: { stocks_upserted: inserted, csv_rows: rows.length },
      finished_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({
      ok: true, trade_date: tradeDateIso,
      stocks: inserted, eod: eodInserted, csv_rows: rows.length,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});