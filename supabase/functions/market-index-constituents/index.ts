// market-index-constituents — fetches an Indian index's member list from
// niftyindices.com and joins the latest computed scores.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// slug → niftyindices CSV filename
const SLUG_TO_FILE: Record<string, string> = {
  nifty50: "ind_nifty50list.csv",
  niftynext50: "ind_niftynext50list.csv",
  nifty100: "ind_nifty100list.csv",
  nifty200: "ind_nifty200list.csv",
  nifty500: "ind_nifty500list.csv",
  niftymidcap100: "ind_niftymidcap100list.csv",
  niftysmallcap100: "ind_niftysmallcap100list.csv",
  niftybank: "ind_niftybanklist.csv",
  niftyit: "ind_niftyitlist.csv",
  niftyauto: "ind_niftyautolist.csv",
  niftypharma: "ind_niftypharmalist.csv",
  niftyfmcg: "ind_niftyfmcglist.csv",
  niftymetal: "ind_niftymetallist.csv",
  niftyrealty: "ind_niftyrealtylist.csv",
  niftyenergy: "ind_niftyenergylist.csv",
  niftyfinservice: "ind_niftyfinancelist.csv",
};

// CSV parser respecting double-quoted fields.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

interface Member { symbol: string; company: string; industry: string | null }

async function fetchCsvMembers(file: string): Promise<Member[]> {
  const urls = [
    `https://niftyindices.com/IndexConstituent/${file}`,
    `https://archives.nseindia.com/content/indices/${file}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) continue;
      const text = await r.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) continue;
      const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
      const iSym = header.findIndex((h) => h === "symbol");
      const iCo = header.findIndex((h) => h.includes("company") || h.includes("name"));
      const iInd = header.findIndex((h) => h.includes("industry") || h.includes("sector"));
      if (iSym < 0) continue;
      const out: Member[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const sym = cols[iSym]?.toUpperCase();
        if (!sym || !/^[A-Z0-9&-]+$/.test(sym)) continue;
        out.push({ symbol: sym, company: iCo >= 0 ? cols[iCo] ?? "" : "", industry: iInd >= 0 ? cols[iInd] ?? null : null });
      }
      if (out.length > 5) return out;
    } catch { /* try next */ }
  }
  return [];
}

// 5-min in-memory cache
const CACHE = new Map<string, { at: number; members: Member[] }>();
const TTL = 5 * 60_000;

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });

    const { slug } = await req.json().catch(() => ({}));
    const key = String(slug ?? "").toLowerCase();
    const file = SLUG_TO_FILE[key];
    if (!file) return jsonResponse(req, { members: [], reason: "unsupported slug" });

    const cached = CACHE.get(key);
    let members: Member[];
    if (cached && Date.now() - cached.at < TTL) {
      members = cached.members;
    } else {
      members = await fetchCsvMembers(file);
      if (members.length > 0) CACHE.set(key, { at: Date.now(), members });
    }
    if (members.length === 0) return jsonResponse(req, { members: [], reason: "empty upstream" });

    const symbols = members.map((m) => m.symbol);
    const svc = svcClient();
    // Latest score per symbol
    const { data: scores } = await svc
      .from("market_stock_scores")
      .select("symbol,exchange,trade_date,close,change_pct,breakout_score,prebreakout_score,sector,rel_volume,rsi14")
      .in("symbol", symbols)
      .order("trade_date", { ascending: false });
    const latest = new Map<string, any>();
    for (const s of scores ?? []) if (!latest.has(s.symbol)) latest.set(s.symbol, s);

    const out = members.map((m) => {
      const s = latest.get(m.symbol);
      return {
        symbol: m.symbol,
        company: m.company,
        sector: s?.sector ?? m.industry ?? null,
        close: s?.close ?? null,
        change_pct: s?.change_pct ?? null,
        breakout_score: s?.breakout_score ?? null,
        prebreakout_score: s?.prebreakout_score ?? null,
        rel_volume: s?.rel_volume ?? null,
        rsi14: s?.rsi14 ?? null,
      };
    });
    return jsonResponse(req, { members: out, count: out.length, slug: key });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
