// Yahoo Finance crumb/cookie session for the v10 quoteSummary endpoint.
// Yahoo now returns HTTP 401 to anonymous quoteSummary calls — a valid cookie
// (from fc.yahoo.com — finance.yahoo.com's cookie is rejected by getcrumb) plus
// the matching crumb (from /v1/test/getcrumb) are required. We use raw fetch here
// because the project's safeFetch blocks fc.yahoo.com (its ^fc private-host rule)
// and discards Set-Cookie headers; raw fetch has neither limitation.

const COOKIE_HOST = "https://fc.yahoo.com/";
const CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const QS_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

interface Session { cookie: string; crumb: string }
let cached: Session | null = null;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 6000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function newSession(): Promise<Session | null> {
  // 1) cookie
  const c = await fetchWithTimeout(COOKIE_HOST, { headers: { "User-Agent": UA, Accept: "text/html" } });
  // Deno exposes Set-Cookie via getSetCookie(); fall back to the combined header.
  const setCookies = (c.headers as any).getSetCookie?.() as string[] | undefined;
  const raw = setCookies?.length ? setCookies : (c.headers.get("set-cookie") ? [c.headers.get("set-cookie")!] : []);
  const cookie = raw.map((s) => s.split(";")[0]).join("; ");
  if (!cookie) return null;

  // 2) crumb (needs the cookie)
  const cr = await fetchWithTimeout(CRUMB_URL, { headers: { "User-Agent": UA, Cookie: cookie } });
  if (!cr.ok) return null;
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.includes("<")) return null; // html error page, not a crumb
  return { cookie, crumb };
}

async function session(force = false): Promise<Session | null> {
  if (!force && cached) return cached;
  cached = await newSession();
  return cached;
}

/** Fetch a Yahoo quoteSummary result[0] for a symbol, with crumb auth + one
 *  refresh-and-retry on 401/403. Returns null on failure (caller stamps cursor). */
export async function yahooQuoteSummary(yahooSymbol: string, modules: string): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await session(attempt === 1);
    if (!s) continue;
    for (const host of QS_HOSTS) {
      const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}` +
        `?modules=${modules}&crumb=${encodeURIComponent(s.crumb)}`;
      try {
        const r = await fetchWithTimeout(url, { headers: { "User-Agent": UA, Cookie: s.cookie } });
        if (r.status === 401 || r.status === 403) { cached = null; break; } // force refresh, retry outer loop
        if (!r.ok) continue;
        const j = await r.json();
        const result = j?.quoteSummary?.result?.[0];
        if (result) return result;
      } catch { /* try next host */ }
    }
  }
  return null;
}
