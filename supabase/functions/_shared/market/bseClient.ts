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
