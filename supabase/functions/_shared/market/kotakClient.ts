// Kotak Neo v2 (TOTP flow) API client. The consumer key is the bearer credential.
// Docs: github.com/Kotak-Neo/kotak-neo-api-v2. Tokens die daily (~midnight IST);
// with an encrypted TOTP secret + MPIN stored we can re-login unattended.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decryptStatementPassword, type StatementPasswordRule } from "../crypto.ts";
import { isKotakSessionFailure } from "./kotakErrorClassifier.ts";
import { totp } from "./totp.ts";
import { isRouteOpen, noteRouteFailure, noteRouteSuccess, routeOpenReason } from "./routeBreaker.ts";

const NEO_FIN_KEY = "neotradeapi";
// Login endpoints live on a fixed host; every post-login call uses the
// `baseUrl` returned by tradeApiValidate (stored in market_api_settings.base_url).
const LOGIN_HOST = "https://mis.kotaksecurities.com";

export interface KotakSettings {
  id: string;
  user_id: string;
  consumer_key: string | null;
  mobile_number_enc: string | null;
  mpin_enc: string | null;
  totp_secret_enc: string | null;
  base_url: string | null;
  ucc: string | null;
  view_token_enc: string | null;
  session_token_enc: string | null;
  sid: string | null;
  hs_server_id: string | null;
  connection_status: string;
  token_expires_at: string | null;
}

export const KOTAK_SETTINGS_COLS =
  "id,user_id,consumer_key,mobile_number_enc,mpin_enc,totp_secret_enc,base_url,ucc,view_token_enc,session_token_enc,sid,hs_server_id,connection_status,token_expires_at";

async function dec(encJson: string | null): Promise<string | null> {
  if (!encJson) return null;
  return decryptStatementPassword(JSON.parse(encJson) as StatementPasswordRule);
}

function apiBase(s: KotakSettings): string {
  const b = (s.base_url ?? "").replace(/\/+$/, "");
  if (!b) throw new KotakError("Kotak session has no baseUrl — login again", 401);
  return b;
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function looksLikeDynamicKotakBase(value: unknown): string {
  const text = firstNonEmpty(value).replace(/\/+$/, "");
  if (!text) return "";
  try {
    const host = new URL(text).hostname.toLowerCase();
    // Post-login API hosts are data-center hosts like e21/e41. The old
    // gateway/default host is not safe for order/report calls after v2 login.
    return /^e\d{2}\.kotaksecurities\.com$/.test(host) ? text : "";
  } catch {
    return "";
  }
}

function hsServerIdFromBaseUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    const match = host.match(/^e(\d)\d\.kotaksecurities\.com$/);
    return match ? `server${match[1]}` : "";
  } catch {
    return "";
  }
}

function authPayloadSummary(payload: unknown): string {
  const data = (payload as any)?.data ?? {};
  const summary = {
    hasToken: !!data?.token,
    hasSid: !!data?.sid,
    hasRid: !!data?.rid,
    hsServerId: firstNonEmpty(data?.hsServerId) || null,
    baseUrl: firstNonEmpty(data?.baseUrl) || null,
    dataCenter: firstNonEmpty(data?.dataCenter) || null,
    kType: firstNonEmpty(data?.kType) || null,
    status: firstNonEmpty(data?.status) || null,
  };
  return JSON.stringify(summary);
}

function combinedAuthSummary(login: unknown, validate: unknown): string {
  return JSON.stringify({
    login: JSON.parse(authPayloadSummary(login)),
    validate: JSON.parse(authPayloadSummary(validate)),
  });
}


// Next midnight IST expressed in UTC — Kotak sessions die around then.
export function nextIstMidnightIso(): string {
  const nowIst = Date.now() + 5.5 * 3600_000;
  const istMidnight = Math.ceil(nowIst / 86_400_000) * 86_400_000;
  return new Date(istMidnight - 5.5 * 3600_000).toISOString();
}

export class KotakError extends Error {
  constructor(message: string, public status: number, public body?: string) {
    super(message);
  }
}

// Thrown by withKotakSession(..., { retryOnAuthError: false }) when a 401/403
// hits mid-request for an order-mutating call. Whether the order reached the
// broker before the auth error is genuinely unknown — callers must NOT treat
// this the same as a clean rejection (which is safe to let a caller retry).
export class KotakAmbiguousOrderError extends KotakError {}

function isKotakSessionError(error: KotakError): boolean {
  // A 403 from an order endpoint can be a broker/business rejection (for
  // example, SELL quantity or product restrictions), not an expired token.
  // Bare "unauthorised" is too broad because Kotak also uses it for RMS/
  // business rejections. The pure helper only matches explicit token/session
  // expiry/invalid/missing language.
  return isKotakSessionFailure(error.status, `${error.message} ${error.body ?? ""}`);
}

// rate_limit column on market_api_settings documents the user's Kotak tier
// but nothing enforces it client-side — Kotak's APIM gateway is the actual
// throttle. On 429, back off and retry rather than surfacing an error (the
// only place in this backend besides yahooClient.ts that needs this).
async function kotakFetch(url: string, init: RequestInit, attempt = 1): Promise<any> {
  const r = await fetch(url, init);
  // Kotak's APIM gateway burst-limits aggressively; a ~400ms linear backoff
  // with two tries was far too weak. Exponential (0.8s → 1.6s → 3.2s → 6.4s)
  // with jitter, honouring Retry-After when the gateway sends one.
  if (r.status === 429 && attempt <= 4) {
    const retryAfterSec = Number(r.headers.get("retry-after"));
    const base = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : 800 * 2 ** (attempt - 1);
    const delayMs = base + Math.floor(Math.random() * 250);
    await new Promise((res) => setTimeout(res, delayMs));
    return kotakFetch(url, init, attempt + 1);
  }
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  if (!r.ok) {
    // Kotak's APIM gateway often returns 5xx with the real reason only in the
    // raw body (fault string, maintenance notice, rate-limit), and no parseable
    // error field. Surface that body instead of collapsing to "Kotak API 502".
    const apiMsg =
      json?.error?.[0]?.message ?? json?.message ?? json?.errMsg ?? json?.fault?.message;
    const bodySnippet = text ? text.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const detail = apiMsg ? String(apiMsg) : bodySnippet || `HTTP ${r.status}`;
    throw new KotakError(`Kotak API ${r.status}: ${detail}`, r.status, text.slice(0, 500));
  }
  return json;
}

export interface KotakSession {
  viewToken: string;
  editToken: string;
  editSid: string;
  hsServerId: string;
  rid: string | null;
  dataCenter: string | null;
  greetingName: string | null;
  ucc: string | null;
  apiBase: string;
}

/** "9876543210" | "09876543210" | "919876543210" | "+919876543210" → "+919876543210" */
export function normalizeKotakMobile(raw: string): string {
  const digits = (raw || "").replace(/[^\d]/g, "").replace(/^0+/, "");
  const local = digits.length > 10 && digits.startsWith("91") ? digits.slice(2) : digits;
  return `+91${local}`;
}


// Kotak Neo v2 login. Two-step: tradeApiLogin (TOTP) then tradeApiValidate (MPIN).
// Both hit https://mis.kotaksecurities.com. The validate response carries the
// `baseUrl` used for every subsequent authenticated call.
export async function kotakLogin(
  s: KotakSettings,
  totpCode: string,
): Promise<KotakSession> {
  if (!s.consumer_key) throw new KotakError("Consumer key not configured", 400);
  const mobile = await dec(s.mobile_number_enc);
  const mpin = await dec(s.mpin_enc);
  if (!mobile) throw new KotakError("Mobile number not configured", 400);
  if (!mpin) throw new KotakError("MPIN not configured", 400);
  if (!s.ucc) throw new KotakError("UCC not configured", 400);

  // A stored number may already carry the country code ("91XXXXXXXXXX") — the
  // old `+91${...}` prefix turned that into +9191XXXXXXXXXX and Kotak rejected
  // the login. Normalise to a single leading +91.
  const mobileNumber = normalizeKotakMobile(mobile);

  const login = await kotakFetch(`${LOGIN_HOST}/login/1.0/tradeApiLogin`, {
    method: "POST",
    headers: {
      Authorization: s.consumer_key,
      "neo-fin-key": NEO_FIN_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mobileNumber, ucc: s.ucc, totp: totpCode }),
  });
  const viewToken = login?.data?.token;
  const viewSid = login?.data?.sid;
  if (!viewToken || !viewSid) {
    throw new KotakError("Kotak login: no token in response", 502, authPayloadSummary(login));
  }

  const validate = await kotakFetch(`${LOGIN_HOST}/login/1.0/tradeApiValidate`, {
    method: "POST",
    headers: {
      Authorization: s.consumer_key,
      "neo-fin-key": NEO_FIN_KEY,
      "Content-Type": "application/json",
      sid: viewSid,
      Auth: viewToken,
    },
    body: JSON.stringify({ mpin }),
  });
  const editToken = validate?.data?.token;
  const editSid = validate?.data?.sid;
  const baseUrl = firstNonEmpty(
    validate?.data?.baseUrl,
    looksLikeDynamicKotakBase(s.base_url),
  ).replace(/\/+$/, "");
  // Kotak's v2 docs/examples disagree with production: TOTP login usually
  // carries hsServerId, MPIN validate often sends it blank, and some live
  // accounts now send it blank in BOTH responses while still returning a
  // dynamic baseUrl such as https://e41.kotaksecurities.com. The SDK needs an
  // sId (`server4` for e41, `server2` for e21, etc.) for order/report APIs, so
  // derive it from the data-center host when Kotak omits it.
  const hsServerId = firstNonEmpty(
    validate?.data?.hsServerId,
    login?.data?.hsServerId,
    hsServerIdFromBaseUrl(baseUrl),
    s.hs_server_id,
  );
  if (!editToken || !editSid) {
    throw new KotakError("Kotak validate: no session token", 502, authPayloadSummary(validate));
  }
  if (!baseUrl) {
    throw new KotakError("Kotak validate: no baseUrl in response", 502, authPayloadSummary(validate));
  }
  if (!hsServerId) {
    throw new KotakError("Kotak validate: no hsServerId in response", 502, combinedAuthSummary(login, validate));
  }

  return {
    viewToken,
    editToken,
    editSid,
    hsServerId,
    rid: validate?.data?.rid ?? null,
    dataCenter: validate?.data?.dataCenter ?? null,
    greetingName: validate?.data?.greetingName ?? login?.data?.greetingName ?? null,
    ucc: validate?.data?.ucc ?? login?.data?.ucc ?? s.ucc,
    apiBase: baseUrl,
  };
}


// Login using the stored TOTP secret (unattended path).
// totp() generates a code for exactly the current 30s window with no
// clock-skew tolerance. If the edge runtime's clock has drifted from
// Kotak's server clock near a window boundary, the code we submit can land
// in the wrong window and get rejected even though the secret itself is
// fine. Since we're generating (not verifying) a code, there's no way to
// know the skew direction in advance — try the adjacent windows before
// giving up, mirroring the ±1-step tolerance a normal TOTP verifier would
// apply.
//
// BUT: when the broker explicitly answers "invalid OTP", an adjacent window
// cannot help (the secret/registration is wrong), and hammering three codes
// back-to-back is exactly what trips a broker-side lockout. Stop on that
// answer, and space the remaining attempts with jitter.
export function isInvalidOtpAnswer(e: unknown): boolean {
  const msg = `${e instanceof Error ? e.message : String(e)} ${(e as KotakError)?.body ?? ""}`;
  return /invalid\s*(otp|totp)|otp\s*(is\s*)?(invalid|incorrect|wrong)|incorrect\s*(otp|totp)/i.test(msg);
}

export async function kotakAutoLogin(s: KotakSettings): Promise<KotakSession> {
  const secret = await dec(s.totp_secret_enc);
  if (!secret) throw new KotakError("TOTP secret not configured", 400);
  const now = Date.now();
  let lastErr: unknown;
  const offsets = [0, -30_000, 30_000];
  for (let i = 0; i < offsets.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 750 + Math.floor(Math.random() * 750)));
    try {
      const code = await totp(secret, { timeMs: now + offsets[i] });
      return await kotakLogin(s, code);
    } catch (e) {
      lastErr = e;
      // Explicit rejection of the code itself — retrying another window only
      // burns attempts against the broker's lockout counter.
      if (isInvalidOtpAnswer(e)) throw e;
    }
  }

  throw lastErr;
}

// Post-login calls need BOTH the session pair (Auth/Sid) AND the app
// credential (Authorization: <consumer key> + neo-fin-key). Omitting the
// consumer key made every /script-details quote call return
// `{"error":true,"message":"unauthorised"}` with a perfectly valid session —
// verified against the live gateway: identical request 401s without it and
// 200s with it. Portfolio routes happen to accept the session alone, but
// sending the full set everywhere is what Kotak's own SDK does.
async function sessionHeaders(s: KotakSettings): Promise<Record<string, string>> {
  const editToken = await dec(s.session_token_enc);
  if (!editToken || !s.sid) throw new KotakError("No active Kotak session", 401);
  const h: Record<string, string> = {
    Auth: editToken,
    Sid: s.sid,
    accept: "*/*",
    "neo-fin-key": NEO_FIN_KEY,
  };
  if (s.consumer_key) h.Authorization = s.consumer_key;
  return h;
}


function appendSId(s: KotakSettings): string {
  const sid = firstNonEmpty(s.hs_server_id, hsServerIdFromBaseUrl(apiBase(s)));
  return sid ? `?sId=${encodeURIComponent(sid)}` : "";
}

function requireServerId(s: KotakSettings): void {
  if (!firstNonEmpty(s.hs_server_id, hsServerIdFromBaseUrl(apiBase(s)))) {
    throw new KotakError("Kotak session is missing server id — reconnect required", 401);
  }
}

function routeUrl(s: KotakSettings, path: string, includeSId = true): string {
  const base = apiBase(s);
  const cleanPath = path.replace(/^\/+/, "");
  return `${base}/${cleanPath}${includeSId ? appendSId(s) : ""}`;
}

async function kotakRouteFetch(
  s: KotakSettings,
  paths: string[],
  init: RequestInit,
): Promise<any> {
  let lastErr: unknown = null;
  for (const path of paths) {
    try {
      return await kotakFetch(routeUrl(s, path), init);
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number } | null)?.status;
      // Kotak has both legacy `quick/*` and NAPI `Orders/2.0/*` route
      // families. Some sessions return a baseUrl that accepts only one of
      // them. Try the sibling route on 404, but do not mask auth/session
      // failures or real broker-side rejections.
      if (status !== 404) throw e;
    }
  }
  throw lastErr ?? new KotakError("Kotak route not found", 404);
}

export async function kotakHoldings(s: KotakSettings): Promise<any[]> {
  const h = await sessionHeaders(s);
  const j = await kotakFetch(`${apiBase(s)}/portfolio/v1/holdings`, { headers: h });
  return j?.data ?? [];
}

// Full envelope variant — sync uses `stat` to distinguish "empty book" from
// "upstream returned garbage" before deleting rows. If `stat` is absent we
// treat presence of a `data` array as OK (Kotak has inconsistent envelopes).
//
// Neo answers an *empty* book with `{stCode: 5203, errMsg: "No Data",
// stat: "Not_Ok"}`. That is a successful "you hold nothing", not a failure —
// reporting it as broken made the Holdings/Positions feeds show as DOWN on a
// perfectly healthy session.
function kotakEmptyBook(raw: any): boolean {
  const code = Number(raw?.stCode ?? raw?.stcode ?? 0);
  const msg = String(raw?.errMsg ?? raw?.emsg ?? raw?.desc ?? "").toLowerCase();
  return code === 5203 || /no data|data not found|no records?/.test(msg);
}

function bookEnvelope(j: any): { rows: any[]; ok: boolean; raw: any } {
  const rows = Array.isArray(j?.data) ? j.data : [];
  const stat = String(j?.stat ?? j?.stCode ?? "").toLowerCase();
  const ok = stat === "ok" || (stat === "" && Array.isArray(j?.data)) || kotakEmptyBook(j);
  return { rows, ok, raw: j };
}

export async function kotakHoldingsEnvelope(s: KotakSettings): Promise<{ rows: any[]; ok: boolean; raw: any }> {
  const h = await sessionHeaders(s);
  const j = await kotakFetch(`${apiBase(s)}/portfolio/v1/holdings`, { headers: h });
  return bookEnvelope(j);
}

export async function kotakPositions(s: KotakSettings): Promise<any[]> {
  requireServerId(s);
  const h = await sessionHeaders(s);
  const j = await kotakRouteFetch(s, ["quick/user/positions", "Orders/2.0/quick/user/positions"], { headers: h });
  return j?.data ?? [];
}

export async function kotakPositionsEnvelope(s: KotakSettings): Promise<{ rows: any[]; ok: boolean; raw: any }> {
  requireServerId(s);
  const h = await sessionHeaders(s);
  const j = await kotakRouteFetch(s, ["quick/user/positions", "Orders/2.0/quick/user/positions"], { headers: h });
  return bookEnvelope(j);
}


export async function kotakLimits(s: KotakSettings): Promise<any> {
  requireServerId(s);
  const h = await sessionHeaders(s);
  // Neo's REST surface takes `jData=<json>` as x-www-form-urlencoded — exactly
  // like the order routes. Posting a raw JSON body made the gateway answer
  // "404 page not found" on every combo, which surfaced in the UI as a broken
  // Funds feed even on a perfectly healthy session.
  const combos: Array<{ seg: string; exch: string; prod: string }> = [
    { seg: "CASH", exch: "NSE", prod: "ALL" },
    { seg: "ALL",  exch: "ALL", prod: "ALL" },
    { seg: "FO",   exch: "NSE", prod: "ALL" },
  ];
  let lastErr: unknown = null;
  for (const body of combos) {
    try {
      const j = await kotakRouteFetch(s, ["quick/user/limits", "Orders/2.0/quick/user/limits"], {
        method: "POST",
        headers: { ...h, "Content-Type": "application/x-www-form-urlencoded" },
        body: jDataForm(body),
      });
      // Only accept combos that returned a real payload; empty {} → next combo.
      if (j && typeof j === "object" && Object.keys(j).length > 0) return j;
    } catch (e) {
      lastErr = e;
      const status = (e as any)?.status;
      // Auth failures are terminal — no combo will fix a bad session.
      if (typeof status === "number" && status === 401) throw e;
      if (typeof status === "number" && status === 403) throw e;
      // Everything else (429, 5xx, empty-body) → try the next combo.
    }
  }
  throw lastErr ?? new KotakError("Kotak limits: no payload from any segment combination", 502);
}

// Classify a funds failure into a stable code for market_api_settings
// .funds_last_error_code, so the Config screen can say *why* funds are stale
// instead of the useless "unknown".
export function classifyFundsError(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  const msg = String((e as Error)?.message ?? e ?? "").toLowerCase();
  if (status === 401 || status === 403) return "session";
  if (status === 404) return "route_404";
  if (status === 429) return "throttled";
  if (typeof status === "number" && status >= 500) return "broker_5xx";
  if (msg.includes("empty") || msg.includes("no payload")) return "empty_payload";
  return "unknown";
}



// Quotes need an active session and go through the per-user baseUrl.
// neoSymbols look like "nse_cm|11536".
export async function kotakQuotes(
  s: KotakSettings,
  neoSymbols: string[],
  quoteType: "ltp" | "ohlc" | "all" = "all",
): Promise<any[]> {
  if (neoSymbols.length === 0) return [];
  const h = await sessionHeaders(s);
  const path = encodeURIComponent(neoSymbols.join(","));
  const j = await kotakFetch(
    `${apiBase(s)}/script-details/1.0/quotes/neosymbol/${path}/${quoteType}`,
    { headers: { ...h, accept: "application/json" } },
  );
  const d = j?.data ?? j;
  return Array.isArray(d) ? d : [d].filter(Boolean);
}

export async function kotakScripFilePaths(s: KotakSettings): Promise<string[]> {
  const h = await sessionHeaders(s);
  const j = await kotakFetch(`${apiBase(s)}/script-details/1.0/masterscrip/file-paths`, {
    headers: { ...h, accept: "application/json" },
  });
  return j?.data?.filesPaths ?? j?.filesPaths ?? [];
}

// Historical candles via /charts/v2/history. Returns [{time,open,high,low,close,volume}]
// where `time` is unix seconds. Intervals: "1","5","15","60","D","W","M".
//
// CIRCUIT-BROKEN. On accounts whose gateway does not expose the charts family
// this route answers a bare "404 page not found" for every symbol. The caller
// falls back to Yahoo, so charts kept working — but the pipeline still paid a
// doomed round-trip per symbol per run and logged a provider-health row each
// time: 9,658 identical failures in one day against a 500 MB database. The
// breaker turns that into one probe per isolate, then straight to fallback.
export const KOTAK_CANDLES_ROUTE = "kotak:charts/v2/history";

// CONFIRMED 2026-07-30: Kotak Neo has NO historical/candle API. Every route in
// the charts family (`/charts/v2/history` POST + GET, `/charts/v1/*`,
// `/chart/v2/*`, and the gw-napi host) answers "404 page not found" on a live,
// authenticated session whose quotes route returns 200 on the very same
// headers — and Kotak's own support page says "Historical data is unavailable
// at the moment. This feature is not allowed for this platform."
// So we stop asking: no round-trip, no breaker churn, no health-log noise.
// Candles come from our own stores (market_daily_prices / market_intraday_
// prices) plus Yahoo, with the live Kotak QUOTE stitched on as the forming bar.
export const KOTAK_HISTORY_SUPPORTED = false;

export async function kotakCandles(
  s: KotakSettings,
  instrumentToken: string,
  exchangeSegment: string, // "nse_cm" | "bse_cm" | "nse_fo"
  fromEpoch: number,
  toEpoch: number,
  interval: string,
): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
  if (!KOTAK_HISTORY_SUPPORTED) {
    throw new KotakError("Kotak Neo does not expose a historical candles API", 404);
  }
  if (isRouteOpen(KOTAK_CANDLES_ROUTE)) {
    // Surface as a normal 404 so existing fallback logic is unchanged.
    throw new KotakError(routeOpenReason(KOTAK_CANDLES_ROUTE), 404);
  }

  const h = await sessionHeaders(s);
  const body = {
    exch: exchangeSegment.startsWith("bse") ? "BSE" : exchangeSegment.startsWith("nse_fo") ? "NFO" : "NSE",
    token: String(instrumentToken),
    fromDate: String(fromEpoch),
    toDate: String(toEpoch),
    interval,
  };
  let j: any;
  try {
    j = await kotakFetch(`${apiBase(s)}/charts/v2/history`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const status = (e as { status?: number } | null)?.status;
    const opened = noteRouteFailure(KOTAK_CANDLES_ROUTE, status, (e as Error).message ?? "candles failed");
    if (opened) console.warn(`[kotak] ${routeOpenReason(KOTAK_CANDLES_ROUTE)}`);
    throw e;
  }
  noteRouteSuccess(KOTAK_CANDLES_ROUTE);
  const raw = j?.data?.candles ?? j?.candles ?? j?.data ?? [];
  if (!Array.isArray(raw)) return [];
  // Kotak returns rows either as arrays [t,o,h,l,c,v] or objects.
  return raw
    .map((r: any) => {
      if (Array.isArray(r)) {
        return { time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5] ?? 0) };
      }
      return {
        time: Number(r.time ?? r.t ?? 0),
        open: Number(r.open ?? r.o ?? 0),
        high: Number(r.high ?? r.h ?? 0),
        low: Number(r.low ?? r.l ?? 0),
        close: Number(r.close ?? r.c ?? 0),
        volume: Number(r.volume ?? r.v ?? 0),
      };
    })
    .filter((c) => Number.isFinite(c.time) && c.time > 0 && Number.isFinite(c.close));
}

// Level-2 market depth (best 5 bid/ask).
//
// Two things made this permanently empty while quotes were healthy:
//  1) Kotak serves the ladder in more than one shape. The `all` quote payload
//     can carry `depth: { buy: [...], sell: [...] }`, but the gateway also
//     answers with the FLAT websocket-style field family documented in the
//     Neo SDK (`docs/webSocket.md`): bp/bp1..bp4 (bid price, levels 1-5),
//     bq/bq1..bq4, sp/sp1..sp4, bs/bs1..bs4, bno1..bno5 / sno1..sno5.
//     The old parser only understood the nested form and silently produced [].
//  2) When `all` carries no book at all, the `depth` quote_type (documented in
//     Kotak-neo-api-v2) is the variant that does. We now probe it as a
//     fallback and remember which variant worked for this isolate.
export type KotakDepthBook = {
  bids: Array<{ price: number; qty: number; orders: number }>;
  asks: Array<{ price: number; qty: number; orders: number }>;
  ltp: number | null;
  /** Diagnostic: what the payload looked like when nothing was parseable. */
  payloadKeys?: string[];
};

// `market_depth` is the quote_type Kotak documents in the Neo SDK; `depth`
// and `all` both work on the e41 gateway (verified 2026-07-30).
const DEPTH_VARIANTS = ["depth", "all", "market_depth"] as const;
let preferredDepthVariant: string | null = null;

const dnum = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

// Flat Neo shape: level 1 has no suffix, levels 2-5 use suffix 1..4, while
// order counts use 1..5 across all five levels (yes, really — that asymmetry
// is exactly how Kotak documents it).
// `q` accepts several candidate quantity keys because the gateway is not
// consistent: the buy side is bq/bs, the sell side sq/ss. Reading the sell
// quantity from the BUY key (the old bug) silently produced zero/garbage ask
// sizes with no error raised.
export function parseFlatSide(d: any, p: string, q: string | string[], o: string) {
  const qKeys = Array.isArray(q) ? q : [q];
  const rows: Array<{ price: number; qty: number; orders: number }> = [];
  for (let i = 0; i < 5; i++) {
    const sfx = i === 0 ? "" : String(i);
    const price = dnum(d[`${p}${sfx}`]);
    if (price <= 0) continue;
    let qty = 0;
    for (const k of qKeys) {
      const v = dnum(d[`${k}${sfx}`]);
      if (v > 0) { qty = v; break; }
    }
    rows.push({
      price,
      qty,
      orders: dnum(d[`${o}${i + 1}`]),
    });
  }
  return rows;
}


function parseNestedSide(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r: any) => ({
      price: dnum(r?.price ?? r?.p ?? r?.bp ?? r?.sp),
      qty: dnum(r?.quantity ?? r?.qty ?? r?.q ?? r?.bq ?? r?.sq ?? r?.bs ?? r?.ss),
      orders: dnum(r?.orders ?? r?.n ?? r?.no ?? r?.bno ?? r?.sno),
    }))
    .filter((r) => r.price > 0)
    .slice(0, 5);
}

function extractBook(d: any): KotakDepthBook | null {
  if (!d || typeof d !== "object") return null;
  const book = d.depth ?? d;
  const ltp = dnum(d.last_traded_price ?? d.ltp ?? d.lp ?? book?.ltp) || null;

  // 1) Nested arrays.
  let bids = parseNestedSide(book.buy ?? book.bids ?? book.bid);
  let asks = parseNestedSide(book.sell ?? book.asks ?? book.ask);

  // 2) Flat websocket-style keys, on either the envelope or the depth node.
  if (bids.length === 0 && asks.length === 0) {
    for (const src of [book, d]) {
      const fb = parseFlatSide(src, "bp", ["bq", "bs"], "bno");
      const fa = parseFlatSide(src, "sp", ["sq", "ss"], "sno");
      if (fb.length || fa.length) { bids = fb; asks = fa; break; }
    }
  }

  if (bids.length === 0 && asks.length === 0) {
    return { bids: [], asks: [], ltp, payloadKeys: Object.keys(d).slice(0, 40) };
  }
  return { bids: bids.slice(0, 5), asks: asks.slice(0, 5), ltp };
}

export async function kotakDepth(
  s: KotakSettings,
  instrumentToken: string,
  exchangeSegment = "nse_cm",
): Promise<KotakDepthBook | null> {
  const h = await sessionHeaders(s);
  const path = encodeURIComponent(`${exchangeSegment}|${instrumentToken}`);
  const variants = preferredDepthVariant
    ? [preferredDepthVariant, ...DEPTH_VARIANTS.filter((v) => v !== preferredDepthVariant)]
    : [...DEPTH_VARIANTS];

  let last: KotakDepthBook | null = null;
  for (const variant of variants) {
    let j: any;
    try {
      j = await kotakFetch(
        `${apiBase(s)}/script-details/1.0/quotes/neosymbol/${path}/${variant}`,
        { headers: { ...h, accept: "application/json" } },
      );
    } catch (e) {
      // A missing quote_type on this gateway is not fatal — try the next one.
      if (e instanceof KotakError && (e.status === 404 || e.status === 400)) continue;
      throw e;
    }
    // The gateway answers this route with a BARE TOP-LEVEL ARRAY
    // (`[{ exchange_token, depth: { buy, sell } }]`) — not `{ data: [...] }`.
    // The old unwrap missed that case, handed the array itself to
    // extractBook(), and produced an empty book on a perfectly good payload.
    // That is the whole reason A2 said "broker returned an empty order book"
    // while quotes on the identical session were fine.
    const d = Array.isArray(j) ? j[0]
      : Array.isArray(j?.data) ? j.data[0]
      : (j?.data ?? j);
    const book = extractBook(d);
    if (book && (book.bids.length || book.asks.length)) {
      preferredDepthVariant = variant;
      return book;
    }
    last = book ?? last;
  }
  return last;
}



// ---------------------------------------------------------------------
// Order placement (AutoTrade). Endpoint/field names below are assembled
// from Kotak's public docs (kotak-neo-api-v2's Place_Order.md + the Trade
// API guide at kotakneo.com — both confirm POST {baseUrl}/quick/order/
// rule/ms/place with these field names) and this file's existing "quick/
// user/*" sibling endpoints, since Kotak does not publish a single
// authoritative OpenAPI spec. Place Order is corroborated by two
// independent sources; Modify/Cancel paths below follow the same "rule/ms/
// <verb>" family by inference and are NOT independently confirmed —
// kotakFetch() throws loudly on any non-2xx response rather than silently
// misfiring, but verify both with a tiny manual test before relying on
// them from an armed rule.
// ---------------------------------------------------------------------
export interface PlaceOrderInput {
  exchangeSegment: string; // "nse_cm" | "bse_cm"
  tradingSymbol: string; // e.g. "RELIANCE-EQ"
  instrumentToken?: string;
  transactionType: "BUY" | "SELL";
  // MARKET / LIMIT / SL (stop-loss limit) / SL-M (stop-loss market)
  orderType: "MARKET" | "LIMIT" | "SL" | "SL-M";
  product: "MIS" | "CNC" | "NRML";
  quantity: number;
  price?: number; // required for LIMIT / SL
  triggerPrice?: number; // required for SL / SL-M
  validity?: "DAY" | "IOC";
  disclosedQuantity?: number;
  amo?: boolean;
}
export interface KotakOrderResult { orderId: string; status: string; raw: any }

function kotakOrderTypeCode(t: PlaceOrderInput["orderType"]): string {
  switch (t) {
    case "MARKET": return "MKT";
    case "LIMIT": return "L";
    case "SL": return "SL";
    case "SL-M": return "SL-M";
    default: throw new KotakError(`Unsupported order type: ${t as string}`, 400);
  }
}

// Kotak Neo Trade API uses short field names (matches the official
// kotak-neo-api Python SDK place_order payload). Long snake_case keys
// like `exchange_segment` return "400: body invalid".
function orderBody(input: PlaceOrderInput): Record<string, string> {
  const needsTrigger = input.orderType === "SL" || input.orderType === "SL-M";
  const needsPrice = input.orderType === "LIMIT" || input.orderType === "SL";
  const body: Record<string, string> = {
    am: input.amo ? "YES" : "NO",
    dq: String(input.disclosedQuantity ?? 0),
    es: input.exchangeSegment,
    mp: "0",
    pc: input.product,
    pf: "N",
    pr: needsPrice ? String(input.price ?? 0) : "0",
    pt: kotakOrderTypeCode(input.orderType),
    qt: String(input.quantity),
    rt: input.validity ?? "DAY",
    tp: needsTrigger ? String(input.triggerPrice ?? 0) : "0",
    ts: input.tradingSymbol,
    tt: input.transactionType === "BUY" ? "B" : "S",
  };
  if (input.instrumentToken) body.tk = input.instrumentToken;
  return body;
}

// Parse the /quick/user/limits payload into a normalized funds snapshot.
// Kotak returns wildly inconsistent field casing across account types
// (CashAvailable / cashAvailable / Net / MarginUsed / collateral) — try
// every documented spelling and take the first positive match.
export interface KotakFundsSnapshot {
  net_cash: number | null;
  available_margin: number | null;
  used_margin: number | null;
  collateral: number | null;
  payin_amount: number | null;
  // Extended breakdown (nullable — Kotak returns different subsets by account type).
  cash_balance: number | null;
  payout_amount: number | null;
  span_margin: number | null;
  exposure_margin: number | null;
  realized_mtm: number | null;
  unrealized_mtm: number | null;
  raw: unknown;
}
export function parseKotakLimits(j: any): KotakFundsSnapshot {
  const d = j?.data ?? j ?? {};
  const pickNum = (paths: string[]): number | null => {
    for (const p of paths) {
      const v = p.split(".").reduce((acc: any, k) => acc?.[k], d);
      const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  // Field names verified against a live /quick/user/limits payload: the
  // account fields are the *Prsnt family (AmtUntilizedPrsnt = amount still
  // unutilised, AmountUtilizedPrsnt = used), plus RmsCollateral / NotionalCash
  // / RmsPayInAmt. Kotak sends every number as a string.
  const snap: KotakFundsSnapshot = {
    net_cash: pickNum(["Net", "net", "netCash", "NetCash", "NotionalCash"]),
    available_margin: pickNum([
      "CashAvailable", "cashAvailable", "AvailableMargin", "availableMargin",
      "MarginAvailable", "marginAvailable", "AvlblCash", "avlblCash",
      "AmtUntilizedPrsnt", "AmtUtilizedPrsnt",
    ]),
    used_margin: pickNum([
      "MarginUsed", "marginUsed", "MarginUtilized", "marginUtilized",
      "Utilised", "utilised", "MarginUtilised", "marginUtilised",
      "AmountUtilizedPrsnt", "MarginUsedPrsnt",
    ]),
    collateral: pickNum([
      "Collateral", "collateral", "CollateralAmount", "collateralAmount",
      "CollateralValue", "collateralValue", "RmsCollateral",
    ]),
    payin_amount: pickNum(["Payin", "payin", "PayIn", "payIn", "PayinAmount", "payinAmount", "RmsPayInAmt"]),
    cash_balance: pickNum(["Cash", "cash", "CashBalance", "cashBalance", "OpeningBalance", "openingBalance", "NotionalCash"]),
    payout_amount: pickNum(["Payout", "payout", "PayOut", "payOut", "PayoutAmount", "payoutAmount", "RmsPayOutAmt"]),
    span_margin: pickNum(["SPAN", "span", "SpanMargin", "spanMargin", "SpanMarginPrsnt"]),
    exposure_margin: pickNum(["Exposure", "exposure", "ExposureMargin", "exposureMargin", "ExposureMarginPrsnt"]),
    realized_mtm: pickNum(["Realized", "realized", "RealisedMtoM", "realisedMtoM", "RealisedPnL", "realisedPnL", "RealizedMtomPrsnt"]),
    unrealized_mtm: pickNum(["Unrealized", "unrealized", "UnrealisedMtoM", "unrealisedMtoM", "UnrealisedPnL", "unrealisedPnL", "MtoM", "mtoM", "UnrealizedMtomPrsnt"]),
    raw: d,
  };
  // Kotak omits any explicit "available" key for cash-only accounts. Derive it
  // from what it does report instead of reporting null — a real zero balance
  // must read as "₹0 available", not as a broken feed.
  if (snap.available_margin == null) {
    const parts = [snap.net_cash, snap.collateral].filter((n): n is number => n != null);
    if (parts.length) {
      snap.available_margin = parts.reduce((a, b) => a + b, 0) - (snap.used_margin ?? 0);
      (snap as Record<string, unknown>).available_is_derived = true;
    }
  }
  const anyValue = snap.net_cash != null || snap.available_margin != null
    || snap.used_margin != null || snap.collateral != null || snap.payin_amount != null
    || snap.cash_balance != null;
  if (!anyValue) {
    throw new KotakError(
      "Kotak limits payload empty — no recognized fields",
      502,
      JSON.stringify(j).slice(0, 500),
    );
  }
  return snap;
}



// Kotak Neo Trade API expects order endpoints as application/x-www-form-urlencoded
// with the JSON payload wrapped in a `jData` field (mirrors the official
// kotak-neo-api Python SDK). Posting raw JSON returns "400: body invalid".
function jDataForm(payload: Record<string, unknown>): string {
  const params = new URLSearchParams();
  params.set("jData", JSON.stringify(payload));
  return params.toString();
}

export async function kotakPlaceOrder(s: KotakSettings, input: PlaceOrderInput): Promise<KotakOrderResult> {
  requireServerId(s);
  const h = await sessionHeaders(s);
  const j = await kotakFetch(routeUrl(s, "quick/order/rule/ms/place"), {
    method: "POST",
    headers: { ...h, "Content-Type": "application/x-www-form-urlencoded" },
    body: jDataForm(orderBody(input)),
  });
  const orderId = String(j?.nOrdNo ?? j?.data?.nOrdNo ?? j?.orderId ?? "");
  const status = String(j?.stat ?? j?.stCode ?? "");
  if (!orderId) throw new KotakError("Kotak place order: no order id in response", 502, JSON.stringify(j).slice(0, 500));
  return { orderId, status, raw: j };
}

export async function kotakCancelOrder(s: KotakSettings, orderId: string): Promise<KotakOrderResult> {
  requireServerId(s);
  const h = await sessionHeaders(s);
  // Official Neo API v2 route (the previous rule/ms alias is not part of
  // the SDK contract and can return a misleading gateway auth error).
  const j = await kotakFetch(routeUrl(s, "quick/order/cancel"), {
    method: "POST",
    headers: { ...h, "Content-Type": "application/x-www-form-urlencoded" },
    body: jDataForm({ on: orderId, am: "NO" }),
  });
  return { orderId, status: String(j?.stat ?? j?.stCode ?? ""), raw: j };
}

export async function kotakModifyOrder(
  s: KotakSettings,
  orderId: string,
  changes: Partial<Pick<PlaceOrderInput, "quantity" | "price" | "orderType" | "triggerPrice" | "validity">>,
): Promise<KotakOrderResult> {
  requireServerId(s);
  const h = await sessionHeaders(s);
  // Only `on` (order number) is documented. The extra `nOrdNo` was speculative
  // and Kotak 400s on unexpected fields elsewhere in this API family.
  const body: Record<string, string> = { on: orderId };
  if (changes.quantity != null) body.qt = String(changes.quantity);
  if (changes.price != null) body.pr = String(changes.price);
  if (changes.triggerPrice != null) body.tp = String(changes.triggerPrice);
  if (changes.validity) body.rt = changes.validity;
  if (changes.orderType) body.pt = kotakOrderTypeCode(changes.orderType);
  const j = await kotakFetch(routeUrl(s, "quick/order/rule/ms/modify"), {
    method: "POST",
    headers: { ...h, "Content-Type": "application/x-www-form-urlencoded" },
    body: jDataForm(body),
  });
  return { orderId, status: String(j?.stat ?? j?.stCode ?? ""), raw: j };
}

export async function kotakOrders(s: KotakSettings): Promise<any[]> {
  requireServerId(s);
  const h = await sessionHeaders(s);
  const j = await kotakRouteFetch(s, ["quick/user/orders", "Orders/2.0/quick/user/orders"], { headers: { ...h, accept: "application/json" } });
  return j?.data ?? j?.orders ?? [];
}

export async function kotakTrades(s: KotakSettings): Promise<any[]> {
  requireServerId(s);
  const h = await sessionHeaders(s);
  const j = await kotakRouteFetch(s, ["quick/user/trades", "Orders/2.0/quick/user/trades"], { headers: { ...h, accept: "application/json" } });
  return j?.data ?? j?.trades ?? [];
}


// Persist a fresh session onto the settings row (encrypting tokens).
export async function persistSession(
  svc: SupabaseClient,
  s: KotakSettings,
  sess: KotakSession,
  encrypt: (v: string) => Promise<string>,
): Promise<void> {
  const { error } = await svc
    .from("market_api_settings")
    .update({
      view_token_enc: await encrypt(sess.viewToken),
      session_token_enc: await encrypt(sess.editToken),
      sid: sess.editSid,
      hs_server_id: sess.hsServerId,
      rid: sess.rid,
      data_center: sess.dataCenter,
      greeting_name: sess.greetingName,
      ucc: sess.ucc,
      base_url: sess.apiBase,
      connection_status: "connected",
      token_expires_at: nextIstMidnightIso(),
      last_error: null,
    })
    .eq("id", s.id);
  if (error) throw new KotakError(`Could not persist Kotak session: ${error.message}`, 500);
  // reflect in the in-memory object so follow-up calls in the same invocation work
  s.sid = sess.editSid;
  s.hs_server_id = sess.hsServerId;
  s.base_url = sess.apiBase;
  s.session_token_enc = await encrypt(sess.editToken);
  s.connection_status = "connected";
}


// Run an authenticated call; on 401 retry once after unattended re-login.
// In-isolate mutex keyed by settings row id — without this, N concurrent
// fetches that all fail their initial call with 401 would each mint a new
// session, race to persist, and end up with one client holding a token
// that the DB just overwrote (surfacing as a second wave of 401s). We
// serialize the re-login step per settings row within an isolate; the
// waiter re-reads the persisted session before retrying so it inherits
// the fresh tokens minted by the winner.
const reloginLocks: Map<string, Promise<void>> = new Map();

export async function withReloginLock<T>(settingsId: string, fn: () => Promise<T>): Promise<T> {
  const prev = reloginLocks.get(settingsId) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => gate);
  reloginLocks.set(settingsId, chained);
  try { await prev; return await fn(); }
  finally { release(); if (reloginLocks.get(settingsId) === chained) reloginLocks.delete(settingsId); }
}

export async function withKotakSession<T>(
  svc: SupabaseClient,
  s: KotakSettings,
  encrypt: (v: string) => Promise<string>,
  fn: (s: KotakSettings) => Promise<T>,
  opts: { retryOnAuthError?: boolean } = {},
): Promise<T> {
  // retryOnAuthError=false for order-mutating calls (place/modify/cancel/
  // convert): a 401 from Kotak's gateway doesn't reliably mean "the order
  // wasn't accepted" — silently re-logging in and replaying the identical
  // order body risks placing it twice. Reads default to true since retrying
  // a GET is always safe.
  const retryOnAuthError = opts.retryOnAuthError ?? true;
  try {
    return await fn(s);
  } catch (e) {
    if (!(e instanceof KotakError) || !isKotakSessionError(e)) throw e;
    if (retryOnAuthError && s.totp_secret_enc) {
      const fresh: KotakSettings = await withReloginLock(s.id, async () => {
        // Another concurrent call may have already refreshed the session
        // while we waited on the lock. Re-read; if the persisted token is
        // newer than what we came in with, use it and skip the login.
        const { data: latest } = await svc.from("market_api_settings")
          .select("session_token_enc,sid,hs_server_id,base_url,connection_status,token_expires_at")
          .eq("id", s.id).maybeSingle();
        if (latest && latest.connection_status === "connected"
          && latest.session_token_enc && latest.session_token_enc !== s.session_token_enc
          && firstNonEmpty(latest.hs_server_id, hsServerIdFromBaseUrl(String(latest.base_url ?? "")))) {
          return { ...s, ...latest } as KotakSettings;
        }
        const sess = await kotakAutoLogin(s);
        await persistSession(svc, s, sess, encrypt);
        return {
          ...s,
          sid: sess.editSid,
          hs_server_id: sess.hsServerId,
          base_url: sess.apiBase,
          session_token_enc: await encrypt(sess.editToken),
        };
      });
      // The retried call was previously unguarded: a session that keeps
      // failing after a successful re-login was never marked expired, so the
      // UI happily reported "connected" while every call 401'd.
      try {
        return await fn(fresh);
      } catch (retryErr) {
        if (retryErr instanceof KotakError && isKotakSessionError(retryErr)) {
          await svc
            .from("market_api_settings")
            .update({ connection_status: "expired", last_error: "Session expired — re-login required" })
            .eq("id", s.id);
        }
        throw retryErr;
      }
    }
    if (!retryOnAuthError) {
      // Do not mark the entire broker disconnected from a non-retryable order
      // mutation. The order outcome may be ambiguous, but expiring the session
      // here causes a global Kotak fallback/reconnect loop. A later read-only
      // call can safely prove and persist session expiry.
      throw new KotakAmbiguousOrderError(
        "Kotak session expired mid-request — this order may or may not have reached the broker. Check Orders/Trades before resubmitting; do not retry blindly. Reconnect Kotak in Market → Config once verified.",
        e.status, e.body,
      );
    }
    await svc
      .from("market_api_settings")
      .update({ connection_status: "expired", last_error: "Session expired — re-login required" })
      .eq("id", s.id);
    throw e;
  }
}

// Position conversion — change product code (MIS ↔ CNC ↔ NRML) on an open
// position without flattening/re-buying. Kotak Neo endpoint mirrors the
// place/modify pattern; the body shape follows their v2 quick-order API.
// If Kotak returns an error, it surfaces cleanly to the caller.
export interface ConvertPositionInput {
  exchangeSegment: string;     // e.g. "nse_cm"
  tradingSymbol: string;       // e.g. "RELIANCE-EQ"
  instrumentToken?: string;
  transactionType: "BUY" | "SELL"; // side of the OPEN position (long=BUY, short=SELL)
  quantity: number;
  fromProduct: "MIS" | "CNC" | "NRML";
  toProduct: "MIS" | "CNC" | "NRML";
}

export async function kotakConvertPosition(
  s: KotakSettings,
  input: ConvertPositionInput,
): Promise<{ status: string; raw: any }> {
  if (input.fromProduct === input.toProduct) {
    throw new KotakError("From-product and to-product cannot be the same", 400);
  }
  const h = await sessionHeaders(s);
  const body: Record<string, string> = {
    es: input.exchangeSegment,
    ts: input.tradingSymbol,
    qt: String(input.quantity),
    tt: input.transactionType === "BUY" ? "B" : "S",
    fPrd: input.fromProduct,
    tPrd: input.toProduct,
  };
  if (input.instrumentToken) body.tk = input.instrumentToken;
  requireServerId(s);
  const j = await kotakFetch(routeUrl(s, "quick/order/rule/ms/pos-conversion"), {
    method: "POST",
    headers: { ...h, "Content-Type": "application/x-www-form-urlencoded" },
    body: jDataForm(body),
  });
  return { status: String(j?.stat ?? j?.stCode ?? ""), raw: j };
}
