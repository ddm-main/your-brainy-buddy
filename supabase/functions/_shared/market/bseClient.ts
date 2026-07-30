// BSE public-data client — Priority 7 backup per the multi-provider spec.
// Used only for corporate actions/announcements/circulars BSE sometimes
// carries ahead of or instead of NSE (BSE-only listings, BSE-specific
// circulars). BSE's site wants a browser-like Origin/Referer but, unlike
// NSE, doesn't require a pre-flight cookie handshake for these read-only
// JSON endpoints.

const BSE_HOME = "https://www.bseindia.com/";
const BSE_ANNOUNCEMENTS = "https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w";
const BSE_CORP_ACTIONS = "https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w";
const BSE_CIRCULARS = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  Origin: "https://www.bseindia.com",
  Referer: BSE_HOME,
};

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 6000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

const str = (...values: unknown[]): string | null => {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

function toIsoDate(bseDate: string | null | undefined): string | null {
  if (!bseDate) return null;
  const d = new Date(bseDate);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export interface BseAnnouncement {
  headline: string;
  category: string | null;
  pdfUrl: string | null;
  dissemDate: string | null; // when BSE received/published it
}

// scripCode is BSE's numeric code (not the NSE symbol) — callers resolve it
// from market_stocks.isin or a dedicated BSE-code column when one exists;
// this client stays code-agnostic and just proxies BSE's own key.
export async function bseAnnouncements(scripCode: string): Promise<BseAnnouncement[]> {
  const url = `${BSE_ANNOUNCEMENTS}?pageno=1&strCat=-1&strPrevDate=&strScrip=${encodeURIComponent(scripCode)}&strSearch=P&strToDate=&strType=C`;
  try {
    const r = await fetchWithTimeout(url, { headers: HEADERS });
    if (!r.ok) return [];
    const body = await r.json();
    const rows: any[] = Array.isArray(body?.Table) ? body.Table : [];
    return rows.map((row) => ({
      headline: str(row?.NEWSSUB, row?.HEADLINE) ?? "",
      category: str(row?.CATEGORYNAME, row?.CATEGORY),
      pdfUrl: row?.ATTACHMENTNAME ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${row.ATTACHMENTNAME}` : null,
      dissemDate: toIsoDate(str(row?.DissemDT, row?.News_DT)),
    })).filter((a) => a.headline);
  } catch {
    return [];
  }
}

export interface BseCorporateAction {
  actionType: "dividend" | "split" | "bonus" | "results" | "board_meeting" | "other";
  exDate: string | null;
  recordDate: string | null;
  subject: string;
}

function classifyAction(subject: string): BseCorporateAction["actionType"] {
  const s = subject.toLowerCase();
  if (s.includes("dividend")) return "dividend";
  if (s.includes("bonus")) return "bonus";
  if (s.includes("split") || s.includes("sub-division") || s.includes("subdivision")) return "split";
  if (s.includes("board meeting")) return "board_meeting";
  if (s.includes("financial result") || s.includes("results")) return "results";
  return "other";
}

export async function bseCorporateActions(scripCode: string): Promise<BseCorporateAction[]> {
  const url = `${BSE_CORP_ACTIONS}?scripcode=${encodeURIComponent(scripCode)}`;
  try {
    const r = await fetchWithTimeout(url, { headers: HEADERS });
    if (!r.ok) return [];
    const body = await r.json();
    const rows: any[] = Array.isArray(body?.Table) ? body.Table : Array.isArray(body) ? body : [];
    return rows.map((row) => {
      const subject = str(row?.Purpose, row?.PURPOSE_NAME) ?? "";
      return {
        actionType: classifyAction(subject),
        exDate: toIsoDate(str(row?.Ex_date, row?.EX_DATE)),
        recordDate: toIsoDate(str(row?.RecDate, row?.RECORD_DATE)),
        subject,
      };
    }).filter((a) => a.subject);
  } catch {
    return [];
  }
}

export interface BseCircular {
  headline: string;
  subCategory: string | null;
  pdfUrl: string | null;
  date: string | null;
}

// Exchange-wide circulars (not per-symbol) — margin changes, surveillance
// actions, trading-holiday notices, etc.
export async function bseCirculars(subCategory = "Circulars"): Promise<BseCircular[]> {
  const url = `${BSE_CIRCULARS}?strCat=${encodeURIComponent(subCategory)}&strPrevDate=&strToDate=&strSearch=P`;
  try {
    const r = await fetchWithTimeout(url, { headers: HEADERS });
    if (!r.ok) return [];
    const body = await r.json();
    const rows: any[] = Array.isArray(body?.Table) ? body.Table : [];
    return rows.map((row) => ({
      headline: str(row?.SUBJECT, row?.HEADLINE) ?? "",
      subCategory: str(row?.SUBCATNAME),
      pdfUrl: row?.ATTACHMENTNAME ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${row.ATTACHMENTNAME}` : null,
      date: toIsoDate(str(row?.DissemDT, row?.News_DT)),
    })).filter((c) => c.headline);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Live BSE index quotes.
//
// Sensex is a BSE index: NSE's allIndices feed does not carry it and Kotak has
// no working index quote route, so without this the strip could only ever show
// a ~15-minute-delayed Yahoo print. These two endpoints are BSE's own and are
// realtime during the session:
//
//   IndexMovers      — LTP/change/% for EVERY BSE index in one call
//   getScripHeaderData(scripcode=1) — Sensex previous close + OHLC
//
// Both are public and need no key; they only want the browser-like headers
// this module already sends.
// ---------------------------------------------------------------------------

const BSE_INDEX_MOVERS = "https://api.bseindia.com/BseIndiaAPI/api/IndexMovers/w";
const BSE_SCRIP_HEADER = "https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w";

export interface BseIndexQuote {
  /** BSE's short alias, upper-cased and space-collapsed, e.g. "SENSEX". */
  alias: string;
  /** BSE's display name, e.g. "BSE SENSEX". */
  name: string;
  last: number | null;
  change: number | null;
  changePct: number | null;
  previousClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  asOf: string | null;
}

const num = (...values: unknown[]): number | null => {
  for (const v of values) {
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s+]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const aliasKey = (s: string): string => s.trim().toUpperCase().replace(/\s+/g, " ");

// Realtime means realtime: a 3s window is enough to collapse a burst of
// concurrent callers without the strip ever showing a visibly stale tick.
const BSE_INDEX_TTL_MS = 3_000;
let indexCache: { at: number; rows: BseIndexQuote[] } | null = null;
let inflight: Promise<BseIndexQuote[]> | null = null;

async function fetchIndexMovers(): Promise<BseIndexQuote[]> {
  const r = await fetchWithTimeout(`${BSE_INDEX_MOVERS}?indexcode=SENSEX`, { headers: HEADERS });
  if (!r.ok) return [];
  const body = await r.json();
  const rows: any[] = Array.isArray(body?.Table) ? body.Table : [];
  return rows.flatMap((row) => {
    const name = str(row?.indexName, row?.indexName_Par) ?? "";
    const alias = str(row?.shortalias, row?.indexName_Par, row?.indexName);
    const last = num(row?.LTP);
    if (!alias || last == null || last <= 0) return [];
    const change = num(row?.change);
    return [{
      alias: aliasKey(alias),
      name,
      last,
      change,
      changePct: num(row?.PERCENTCHG),
      previousClose: change != null ? last - change : null,
      open: null,
      high: null,
      low: null,
      asOf: str(row?.DT_TM),
    }];
  });
}

// Sensex specifically gets the richer header call so previous close / OHLC
// come from BSE rather than being derived.
async function fetchSensexHeader(): Promise<BseIndexQuote | null> {
  try {
    const r = await fetchWithTimeout(`${BSE_SCRIP_HEADER}?Debtflag=&scripcode=1&seriesid=`, { headers: HEADERS });
    if (!r.ok) return null;
    const body = await r.json();
    const last = num(body?.CurrRate?.LTP, body?.Header?.LTP);
    if (last == null || last <= 0) return null;
    return {
      alias: "SENSEX",
      name: str(body?.Cmpname?.FullN) ?? "BSE SENSEX",
      last,
      change: num(body?.CurrRate?.Chg),
      changePct: num(body?.CurrRate?.PcChg),
      previousClose: num(body?.Header?.PrevClose),
      open: num(body?.Header?.Open),
      high: num(body?.Header?.High),
      low: num(body?.Header?.Low),
      asOf: null,
    };
  } catch {
    return null;
  }
}

/**
 * Live quotes for every BSE index, keyed by BSE's short alias.
 * Fails soft to `[]` so callers can fall through to the next source.
 */
export async function bseIndexQuotes(): Promise<BseIndexQuote[]> {
  if (indexCache && Date.now() - indexCache.at < BSE_INDEX_TTL_MS) return indexCache.rows;
  if (inflight) return await inflight;
  inflight = (async () => {
    try {
      const [movers, sensex] = await Promise.all([
        fetchIndexMovers().catch(() => [] as BseIndexQuote[]),
        fetchSensexHeader(),
      ]);
      const byAlias = new Map(movers.map((m) => [m.alias, m]));
      if (sensex) {
        const prev = byAlias.get("SENSEX");
        // Header wins on the fields it actually carries; keep the movers row's
        // timestamp/name where the header has none.
        byAlias.set("SENSEX", {
          ...sensex,
          name: sensex.name || prev?.name || "BSE SENSEX",
          changePct: sensex.changePct ?? prev?.changePct ?? null,
          asOf: prev?.asOf ?? null,
        });
      }
      const rows = [...byAlias.values()];
      // Never cache an empty read for the full window — BSE blips transiently
      // and the next poll should retry immediately.
      indexCache = { at: rows.length > 0 ? Date.now() : 0, rows };
      return rows;
    } finally {
      inflight = null;
    }
  })();
  return await inflight;
}
