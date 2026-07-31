// Shared index-constituent CSV loader.
//
// The Nifty member lists come from niftyindices.com (with the NSE archives
// mirror as a fallback) — NOT from NSE's `api/equity-stockIndices` JSON API,
// which is IP-blocked for server-side callers. Both the production
// `market-index-constituents` function and the self-test probe use this one
// implementation so the health row reflects the path the app actually takes.

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// slug → niftyindices CSV filename
export const SLUG_TO_FILE: Record<string, string> = {
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

export interface IndexMember { symbol: string; company: string; industry: string | null }

/** CSV parser respecting double-quoted fields. */
export function parseCsvLine(line: string): string[] {
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

export function parseMembersCsv(text: string): IndexMember[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const iSym = header.findIndex((h) => h === "symbol");
  const iCo = header.findIndex((h) => h.includes("company") || h.includes("name"));
  const iInd = header.findIndex((h) => h.includes("industry") || h.includes("sector"));
  if (iSym < 0) return [];
  const out: IndexMember[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const sym = cols[iSym]?.toUpperCase();
    if (!sym || !/^[A-Z0-9&-]+$/.test(sym)) continue;
    out.push({ symbol: sym, company: iCo >= 0 ? cols[iCo] ?? "" : "", industry: iInd >= 0 ? cols[iInd] ?? null : null });
  }
  return out;
}

/** Fetch one index's member list, trying niftyindices then the NSE archives mirror. */
export async function fetchCsvMembers(file: string): Promise<{ members: IndexMember[]; source: string | null }> {
  const urls: Array<[string, string]> = [
    ["niftyindices", `https://niftyindices.com/IndexConstituent/${file}`],
    ["nse-archives", `https://archives.nseindia.com/content/indices/${file}`],
  ];
  for (const [source, url] of urls) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) continue;
      const members = parseMembersCsv(await r.text());
      if (members.length > 5) return { members, source };
    } catch { /* try next mirror */ }
  }
  return { members: [], source: null };
}
