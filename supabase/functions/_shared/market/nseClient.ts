// Lightweight NSE public-data client for Indian equity metadata fallback.
// NSE blocks anonymous API calls unless a browser-like cookie is established
// first, so this helper keeps a short-lived cookie in memory per edge isolate.

const NSE_HOME = "https://www.nseindia.com/";
const NSE_QUOTE = "https://www.nseindia.com/api/quote-equity";
const NSE_CORP_ACTIONS = "https://www.nseindia.com/api/corporates-corporateActions";
const NSE_HOLIDAYS = "https://www.nseindia.com/api/holiday-master";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

interface NseSession { cookie: string; at: number }
let cached: NseSession | null = null;
const TTL = 10 * 60_000;

export interface NseEquityMeta {
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCapCr: number | null;
  price: number | null;
  pe: number | null;
  pb: number | null;
  high52w: number | null;
  low52w: number | null;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5500): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function cookieFrom(headers: Headers): string {
  const setCookies = (headers as any).getSetCookie?.() as string[] | undefined;
  const raw = setCookies?.length ? setCookies : (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  return raw.map((s) => s.split(";")[0]).join("; ");
}

async function session(force = false): Promise<NseSession | null> {
  if (!force && cached && Date.now() - cached.at < TTL) return cached;
  const r = await fetchWithTimeout(NSE_HOME, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const cookie = cookieFrom(r.headers);
  if (!cookie) return null;
  cached = { cookie, at: Date.now() };
  return cached;
}

const num = (...values: unknown[]): number | null => {
  for (const v of values) {
    if (v == null || v === "") continue;
    const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const str = (...values: unknown[]): string | null => {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

function parseMarketCapCr(body: any, price: number | null): number | null {
  const direct = num(body?.metadata?.marketCap, body?.securityInfo?.marketCap, body?.priceInfo?.marketCap);
  if (direct != null) return direct > 1_000_000 ? direct / 1e7 : direct;
  const issued = num(body?.securityInfo?.issuedCap, body?.securityInfo?.issuedSize, body?.metadata?.issuedSize);
  if (issued != null && price != null) return (issued * price) / 1e7;
  return null;
}

export async function nseEquityMeta(symbol: string): Promise<NseEquityMeta | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await session(attempt === 1);
    if (!s) continue;
    const url = `${NSE_QUOTE}?symbol=${encodeURIComponent(symbol.toUpperCase())}`;
    try {
      const r = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: NSE_HOME,
          Cookie: s.cookie,
        },
      });
      if (r.status === 401 || r.status === 403) { cached = null; continue; }
      if (!r.ok) continue;
      const body = await r.json();
      const price = num(body?.priceInfo?.lastPrice, body?.priceInfo?.close, body?.priceInfo?.previousClose);
      return {
        companyName: str(body?.info?.companyName, body?.info?.symbol, body?.metadata?.companyName),
        sector: str(body?.industryInfo?.sector, body?.metadata?.industry, body?.industryInfo?.macro),
        industry: str(body?.industryInfo?.industry, body?.industryInfo?.basicIndustry, body?.metadata?.industry),
        marketCapCr: parseMarketCapCr(body, price),
        price,
        pe: num(body?.metadata?.pdSymbolPe, body?.metadata?.symbolPE, body?.metadata?.pe),
        pb: num(body?.metadata?.pdSymbolPb, body?.metadata?.pb),
        high52w: num(body?.priceInfo?.weekHighLow?.max, body?.priceInfo?.weekHighLow?.max52WeekHigh),
        low52w: num(body?.priceInfo?.weekHighLow?.min, body?.priceInfo?.weekHighLow?.min52WeekLow),
      };
    } catch {
      // retry with a fresh NSE cookie once
    }
  }
  return null;
}

export interface NseCorporateAction {
  actionType: "dividend" | "split" | "bonus" | "results" | "board_meeting" | "other";
  exDate: string | null;
  recordDate: string | null;
  subject: string;
}

// NSE's `purpose`/`subject` field is free text ("Dividend - Rs 5 Per Share",
// "Bonus 1:1", "Face Value Split (Sub-Division)", "Board Meeting", "Financial
// Results") — keyword-classify into our fixed action_type set rather than
// storing NSE's own inconsistent taxonomy.
function classifyAction(subject: string): NseCorporateAction["actionType"] {
  const s = subject.toLowerCase();
  if (s.includes("dividend")) return "dividend";
  if (s.includes("bonus")) return "bonus";
  if (s.includes("split") || s.includes("sub-division") || s.includes("subdivision")) return "split";
  if (s.includes("board meeting")) return "board_meeting";
  if (s.includes("financial result") || s.includes("results")) return "results";
  return "other";
}

function toIsoDate(nseDate: string | null | undefined): string | null {
  // NSE dates are typically "DD-MMM-YYYY" (e.g. "15-Aug-2026").
  if (!nseDate) return null;
  const d = new Date(nseDate);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function nseCorporateActions(symbol: string): Promise<NseCorporateAction[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await session(attempt === 1);
    if (!s) continue;
    const url = `${NSE_CORP_ACTIONS}?index=equities&symbol=${encodeURIComponent(symbol.toUpperCase())}`;
    try {
      const r = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: NSE_HOME,
          Cookie: s.cookie,
        },
      });
      if (r.status === 401 || r.status === 403) { cached = null; continue; }
      if (!r.ok) continue;
      const body = await r.json();
      const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
      return rows.map((row) => {
        const subject = str(row?.subject, row?.purpose, row?.comp) ?? "";
        return {
          actionType: classifyAction(subject),
          exDate: toIsoDate(str(row?.exDate, row?.exdate)),
          recordDate: toIsoDate(str(row?.recDate, row?.recorddate)),
          subject,
        };
      }).filter((a) => a.subject);
    } catch {
      // retry with a fresh NSE cookie once
    }
  }
  return [];
}

export interface NseHoliday { date: string; description: string }

export async function nseHolidays(): Promise<NseHoliday[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await session(attempt === 1);
    if (!s) continue;
    const url = `${NSE_HOLIDAYS}?type=trading`;
    try {
      const r = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: NSE_HOME,
          Cookie: s.cookie,
        },
      });
      if (r.status === 401 || r.status === 403) { cached = null; continue; }
      if (!r.ok) continue;
      const body = await r.json();
      // Response shape groups by segment, e.g. { CM: [{tradingDate, description}, ...], ... }
      const rows: any[] = Array.isArray(body?.CM) ? body.CM : Array.isArray(body?.FO) ? body.FO : [];
      return rows
        .map((row) => ({
          date: toIsoDate(str(row?.tradingDate, row?.date)),
          description: str(row?.description, row?.holidayDate) ?? "Trading holiday",
        }))
        .filter((h): h is NseHoliday => h.date != null);
    } catch {
      // retry with a fresh NSE cookie once
    }
  }
  return [];
}