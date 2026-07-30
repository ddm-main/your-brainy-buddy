// Shoonya (Finvasia Noren) REST client.
//
// Transport: POST `${BASE}/<Route>` with a `jData=<json>` body plus the Noren
// session token as `jKey` (also sent as Bearer for OAuth compatibility).
// Every response is either `{ stat: "Ok", ... }` / an array of such objects,
// or `{ stat: "Not_Ok", emsg: "..." }`.
//
// This integration uses Shoonya's authorization-code flow:
//   1. send the user to  {OAUTH_AUTHORIZE}?client_id=<vendor/client id>
//   2. Shoonya redirects to the Redirect URL registered in the PRISM portal
//      with `?code=...`
//   3. POST /NorenWClientAPI/GenAcsTok with body `jData=<json>` only and
//      { code, checksum: sha256(clientId + secret + code), uid }
//   4. use the returned `access_token` as the bearer/jKey for all calls.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decryptStatementPassword, type StatementPasswordRule } from "../crypto.ts";
import type { Candle } from "./indicators.ts";

export const SHOONYA_HOST = "https://api.shoonya.com";
/**
 * The OAuth-era REST base. Confirmed against Finvasia's reference
 * implementation and the official JS SDK: `GenAcsTok` and the account routes
 * live under `NorenWClientAPI`. The older `NorenWClientTP` base answers
 * `Error Occurred : 5 "no data"` for these payloads.
 */
export const SHOONYA_BASE = `${SHOONYA_HOST}/NorenWClientAPI`;
/** Bases used by earlier implementations; any stored value is migrated away. */
export const SHOONYA_BASE_LEGACY = `${SHOONYA_HOST}/NorenWClientTP`;
export const SHOONYA_BASE_FALLBACK = `${SHOONYA_HOST}/NorenWClientWeb`;
export const SHOONYA_OAUTH_AUTHORIZE = `${SHOONYA_HOST}/OAuthlogin/authorize/oauth`;
export const SHOONYA_GENACSTOK_CONTENT_TYPE = "text/plain";
/** OAuth sessions stream from the API socket, not the legacy TP socket. */
export const SHOONYA_WS = "wss://api.shoonya.com/NorenWSAPI/";
export const SHOONYA_WS_LEGACY = "wss://api.shoonya.com/NorenWSTP/";

/** Where to send the user to authorize this app. */
export function shoonyaOAuthUrl(clientId: string, redirectUrl?: string | null, state?: string | null): string {
  const u = new URL(SHOONYA_OAUTH_AUTHORIZE);
  u.searchParams.set("client_id", clientId);
  // Shoonya primarily uses the Redirect URL saved in PRISM. Supplying the same
  // URL as the OAuth-standard redirect_uri is harmless when ignored, and fixes
  // accounts where the authorize endpoint honors it during the browser bounce.
  if (redirectUrl?.trim()) u.searchParams.set("redirect_uri", redirectUrl.trim());
  // Keep PRISM's registered Redirect URL stable. The current app origin rides
  // in state so the callback can return to the right preview/published host.
  if (state?.trim()) u.searchParams.set("state", state.trim());
  return u.toString();
}



export interface ShoonyaSettings {
  id: string;
  user_id: string;
  /** Shoonya login user id (uid / actid). Stored in `ucc`. */
  ucc: string | null;
  vendor_code: string | null;
  api_secret_enc: string | null;
  password_enc: string | null;
  totp_secret_enc: string | null;
  imei: string | null;
  session_token_enc: string | null;
  base_url: string | null;
  ws_url: string | null;
  connection_status: string;
  token_expires_at: string | null;
  greeting_name: string | null;
}

export const SHOONYA_SETTINGS_COLS =
  "id,user_id,ucc,vendor_code,api_secret_enc,password_enc,totp_secret_enc,imei," +
  "session_token_enc,base_url,ws_url,connection_status,token_expires_at,greeting_name";

export class ShoonyaError extends Error {
  constructor(message: string, public status = 502, public body?: string) {
    super(message);
    this.name = "ShoonyaError";
  }
}

/** Noren reports auth failures in the body, not the HTTP status. */
export function isShoonyaSessionError(message: string): boolean {
  return /session\s*expired|invalid\s*session|not\s*logged\s*in|invalid\s*input\s*:\s*jkey/i.test(message);
}

async function dec(encJson: string | null): Promise<string | null> {
  if (!encJson) return null;
  return decryptStatementPassword(JSON.parse(encJson) as StatementPasswordRule);
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Any stored legacy path is migrated to the live OAuth API path. */
function apiBase(s: Pick<ShoonyaSettings, "base_url">): string {
  const raw = (s.base_url || SHOONYA_BASE).replace(/\/+$/, "");
  return raw === SHOONYA_BASE_LEGACY || raw === SHOONYA_BASE_FALLBACK ? SHOONYA_BASE : raw;
}

/** Raw Noren call. `jKey` is the OAuth access token (sent as bearer too). */
export async function shoonyaPost<T = any>(
  base: string,
  route: string,
  jData: Record<string, unknown>,
  jKey?: string | null,
  opts: { retries?: number; contentType?: string } = {},
): Promise<T> {
  const { retries = 2, contentType = "application/x-www-form-urlencoded" } = opts;
  const host = (base || SHOONYA_BASE).replace(/\/+$/, "");
  const body = `jData=${JSON.stringify(jData)}` + (jKey ? `&jKey=${jKey}` : "");
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (jKey) headers["Authorization"] = `Bearer ${jKey}`;

  const send = () => fetch(`${host}/${route}`, { method: "POST", headers, body });

  // The gateway occasionally answers 5xx from nginx — a broker-side blip, so
  // retry the same host. There is no sibling host to fall back to any more.
  let r = await send();
  let text = await r.text();
  for (let i = 0; i < retries && r.status >= 500; i++) {
    await new Promise((res) => setTimeout(res, 700 * (i + 1)));
    r = await send();
    text = await r.text();
  }

  if (!r.ok && !text.trim().startsWith("{") && !text.trim().startsWith("[")) {
    throw new ShoonyaError(`Shoonya ${route} failed (${r.status})`, r.status, text.slice(0, 500));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ShoonyaError(`Shoonya ${route} returned non-JSON`, 502, text.slice(0, 300));
  }
  const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
  const stat = (envelope as any)?.stat;
  if (stat && stat !== "Ok" && stat !== "OK") {
    const emsg = String((envelope as any)?.emsg ?? "unknown error");
    throw new ShoonyaError(emsg, isShoonyaSessionError(emsg) ? 401 : 400, text.slice(0, 300));
  }
  return parsed as T;
}

// ---------------------------------------------------------------- auth

export interface ShoonyaSession {
  token: string;
  uid: string;
  actid: string;
  greetingName: string | null;
  email?: string | null;
  expiresAt?: string | null;
}

/** The OAuth client id — Shoonya's "Client ID", stored as the vendor code. */
export function shoonyaClientId(s: ShoonyaSettings): string {
  return (s.vendor_code ?? "").trim();
}

/** Step 1 of the OAuth flow: the URL the user must open and log in on. */
export function shoonyaAuthorizeUrl(s: ShoonyaSettings, redirectUrl?: string | null, state?: string | null): string {
  const clientId = shoonyaClientId(s);
  if (!clientId) throw new ShoonyaError("Shoonya client id (vendor code) is not configured", 400);
  return shoonyaOAuthUrl(clientId, redirectUrl, state);
}

/**
 * Accept whatever the user pasted: the bare code, `code=...`, or the whole
 * redirect URL (optionally URL-encoded / quoted). Anything else is rejected
 * by Shoonya as an invalid verifier.
 */
export function normalizeShoonyaCode(raw: string): string {
  let v = (raw ?? "").trim().replace(/^["'<]+|["'>]+$/g, "");
  const fromUrl = v.match(/[?&#](?:code|shoonya_code|request_token)=([^&\s#]+)/i) ?? v.match(/^(?:code|shoonya_code|request_token)=([^&\s#]+)/i);
  if (fromUrl) v = fromUrl[1];
  try {
    if (/%[0-9a-f]{2}/i.test(v)) v = decodeURIComponent(v);
  } catch { /* keep raw */ }
  return v.trim();
}

export function shoonyaInputError(raw: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    const params = new URLSearchParams(u.search);
    const hashParams = new URLSearchParams(u.hash.startsWith("#") ? u.hash.slice(1) : u.hash);
    hashParams.forEach((hashValue, key) => { if (!params.has(key)) params.set(key, hashValue); });
    const code = params.get("shoonya_code") ?? params.get("code") ?? params.get("request_token");
    if (code?.trim()) return null;
    const err = params.get("shoonya_error") ?? params.get("error_description") ?? params.get("error");
    if (err?.trim()) {
      return `Shoonya did not issue an authorization code: ${err}. Register the clean Redirect URL from this panel in PRISM, verify the static IP whitelist, then authorize again.`;
    }
    if (/\/market\/settings/i.test(u.pathname) || /shoonya-oauth-callback/i.test(u.pathname)) {
      return "That URL does not contain a Shoonya authorization code. Register the Redirect URL exactly as shown, then authorize again and wait for Shoonya to return a code.";
    }
  } catch { /* not a URL */ }
  return null;
}

export function isLikelyTotp(value: string): boolean {
  return /^\d{6}$/.test(normalizeShoonyaCode(value));
}

export async function shoonyaTokenRequest(
  uid: string,
  clientId: string,
  secret: string,
  code: string,
): Promise<{ code: string; checksum: string; uid: string }> {
  return { code, checksum: await sha256Hex(`${clientId}${secret}${code}`), uid };
}

function shoonyaExpiryIso(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Shoonya samples expose an epoch, while some OAuth servers use seconds.
  const ms = n > 10_000_000_000 ? n : n > 1_000_000_000 ? n * 1000 : Date.now() + n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Step 2: exchange the `code` from the redirect for an access token.
 * checksum = sha256(clientId + secretCode + code); Shoonya requires the
 * account `uid` alongside the verifier.
 */
/** Best-effort public egress IP of this edge function, for IP-whitelist errors. */
export async function shoonyaEgressIp(): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch("https://api.ipify.org?format=json", { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    const ip = typeof j?.ip === "string" ? j.ip.trim() : "";
    return ip || null;
  } catch {
    return null;
  }
}

export async function shoonyaLoginWithCode(

  s: ShoonyaSettings,
  rawCode: string,
): Promise<ShoonyaSession> {
  const uid = (s.ucc ?? "").trim();
  const clientId = shoonyaClientId(s);
  const secret = (await dec(s.api_secret_enc))?.trim() ?? null;
  const inputError = shoonyaInputError(rawCode);
  if (inputError) throw new ShoonyaError(inputError, 400);
  const code = normalizeShoonyaCode(rawCode);
  const missing = [
    !uid && "user id",
    !clientId && "client id / vendor code",
    !secret && "secret code",
    !code && "authorization code",
  ].filter(Boolean);
  if (missing.length) throw new ShoonyaError(`Shoonya login incomplete — missing: ${missing.join(", ")}`, 400);
  if (!secret) throw new ShoonyaError("Shoonya login incomplete — missing: secret code", 400);
  if (isLikelyTotp(code)) {
    throw new ShoonyaError(
      "That is a 6-digit TOTP, not Shoonya's authorization code. Enter the TOTP on the Shoonya page, finish authorization, then paste the returned redirect URL or its code= value here.",
      400,
    );
  }

  const request = await shoonyaTokenRequest(uid, clientId, secret, code);
  let res: any;
  try {
    // Finvasia's OAuth reference client posts only the `jData` field — no
    // `jKey`, no bearer header — with a text/plain `jData=...` body.
    res = await shoonyaPost<any>(SHOONYA_BASE, "GenAcsTok", request, null, {
      retries: 1,
      contentType: SHOONYA_GENACSTOK_CONTENT_TYPE,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/invalid_ip/i.test(msg)) {
      const ip = await shoonyaEgressIp();
      throw new ShoonyaError(
        "Shoonya rejected the request because the calling IP is not whitelisted (INVALID_IP). " +
        (ip
          ? `Add this exact IP in Shoonya PRISM → API Key → IP whitelist: ${ip}. `
          : "Add the calling server IP in Shoonya PRISM → API Key → IP whitelist. ") +
        "Note that this backend runs on a shared cloud with a rotating egress IP, so a single whitelisted IP may stop matching later — " +
        "if Shoonya lets you save a range (or 0.0.0.0), use that; otherwise re-check this message for the current IP after each failure. " +
        "The authorization code itself is fine; get a fresh one after whitelisting and try again.",
        400,
      );
    }
    if (/no data|invalid.?verifier|invalid input/i.test(msg)) {
      throw new ShoonyaError(
        `Shoonya rejected the authorization code (${msg}). Check, in order: ` +
        "(1) the Redirect URL shown in this panel is saved in Shoonya PRISM → API Key, " +
        "(2) your server IP is whitelisted in the same screen, " +
        "(3) the code is fresh — codes are single-use and expire within minutes, " +
        "(4) User ID, Client ID and Secret Code all belong to the same Shoonya app.",
        400,
      );
    }
    throw e;
  }




  const token = String(res?.susertoken ?? res?.access_token ?? "");
  if (!token) throw new ShoonyaError(`Shoonya returned no access token${res?.emsg ? `: ${res.emsg}` : ""}`, 502);
  return {
    token,
    uid: String(res?.USERID ?? res?.uid ?? uid),
    actid: String(res?.actid ?? res?.ACCOUNT_ID ?? uid),
    greetingName: res?.uname ? String(res.uname) : null,
    email: res?.email ? String(res.email) : null,
    expiresAt: shoonyaExpiryIso(res?.expires_in),
  };
}

/**
 * The authorization-code flow requires user interaction when its session is
 * no longer accepted. Do not silently fall back to password/TOTP QuickAuth.
 */
export function shoonyaAutoLogin(_s: ShoonyaSettings): Promise<ShoonyaSession> {
  return Promise.reject(new ShoonyaError(
    "Shoonya authorization is required. Open Brokers → Shoonya → Authorize with Shoonya, enter your TOTP on Shoonya's page, then paste the returned redirect URL or authorization code.",
    401,
  ));
}


/** Sessions die overnight; expire them at the next 05:00 IST. */
export function nextShoonyaExpiryIso(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  const next = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 5, 0, 0));
  if (next.getTime() <= ist.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return new Date(next.getTime() - (5 * 60 + 30) * 60_000).toISOString();
}

export async function persistShoonyaSession(
  svc: SupabaseClient,
  s: ShoonyaSettings,
  sess: ShoonyaSession,
  encrypt: (v: string) => Promise<string>,
): Promise<void> {
  const session_token_enc = await encrypt(sess.token);
  const { error } = await svc.from("market_api_settings").update({
    session_token_enc,
    ucc: sess.uid,
    greeting_name: sess.greetingName,
    base_url: apiBase(s),
    ws_url: !s.ws_url || s.ws_url === SHOONYA_WS_LEGACY ? SHOONYA_WS : s.ws_url,
    connection_status: "connected",
    token_expires_at: sess.expiresAt ?? nextShoonyaExpiryIso(),
    last_error: null,
  }).eq("id", s.id);
  if (error) throw new ShoonyaError(`Could not persist Shoonya session: ${error.message}`, 500);
  s.session_token_enc = session_token_enc;
  s.connection_status = "connected";
  s.greeting_name = sess.greetingName;
}

export interface ShoonyaCtx {
  base: string;
  jKey: string;
  uid: string;
  actid: string;
}

async function ctxFrom(s: ShoonyaSettings): Promise<ShoonyaCtx> {
  const jKey = await dec(s.session_token_enc);
  if (!jKey) throw new ShoonyaError("No active Shoonya session", 401);
  const uid = (s.ucc ?? "").trim();
  return { base: apiBase(s), jKey, uid, actid: uid };
}

/**
 * Run `fn` with a live session, re-logging in once on session expiry.
 * `retryOnAuthError: false` for order-mutating calls — replaying an order
 * body after an ambiguous auth failure risks a duplicate order.
 */
export async function withShoonyaSession<T>(
  svc: SupabaseClient,
  s: ShoonyaSettings,
  _encrypt: (v: string) => Promise<string>,
  fn: (ctx: ShoonyaCtx) => Promise<T>,
  _opts: { retryOnAuthError?: boolean } = {},
): Promise<T> {
  const markExpired = async (detail: string) => {
    await svc.from("market_api_settings").update({
      session_token_enc: null,
      token_expires_at: null,
      connection_status: "expired",
      last_error: detail,
    }).eq("id", s.id);
    s.session_token_enc = null;
    s.connection_status = "expired";
  };
  if (!s.session_token_enc) {
    const e = await shoonyaAutoLogin(s).catch((reason) => reason);
    const detail = e instanceof Error ? e.message : String(e);
    await markExpired(detail);
    throw e;
  }
  try {
    return await fn(await ctxFrom(s));
  } catch (e) {
    const authFail = e instanceof ShoonyaError && (e.status === 401 || isShoonyaSessionError(e.message));
    if (!authFail) throw e;
    const detail = "Shoonya session expired. Authorize with Shoonya again; enter the TOTP on Shoonya's page, then paste the returned authorization code.";
    await markExpired(detail);
    throw new ShoonyaError(detail, 401);
  }
}

// ------------------------------------------------------------- mappings

/** App exchange -> Noren exchange segment. */
export function norenExchange(exchange: string): string {
  return String(exchange).toUpperCase().startsWith("BSE") ? "BSE" : "NSE";
}

/** Cash-segment trading symbol. NSE appends `-EQ`; BSE does not. */
export function norenTradingSymbol(symbol: string, exchange: string): string {
  const sym = String(symbol).toUpperCase().replace(/-EQ$/, "");
  return norenExchange(exchange) === "NSE" ? `${sym}-EQ` : sym;
}

export function appSymbol(tsym: string): string {
  return String(tsym ?? "").toUpperCase().replace(/-EQ$/, "");
}

export const PRODUCT_TO_NOREN: Record<string, string> = { MIS: "I", CNC: "C", NRML: "M" };
export const NOREN_TO_PRODUCT: Record<string, "MIS" | "CNC" | "NRML"> = {
  I: "MIS", C: "CNC", M: "NRML", B: "MIS", H: "NRML",
};
export const ORDER_TYPE_TO_NOREN: Record<string, string> = {
  MARKET: "MKT", LIMIT: "LMT", SL: "SL-LMT", "SL-M": "SL-MKT",
};

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

// --------------------------------------------------------------- quotes

export interface ShoonyaQuote {
  symbol: string;
  exchange: string;
  price: number;
  previous_close: number | null;
  day_open: number | null;
  day_high: number | null;
  day_low: number | null;
  volume: number | null;
  high_52w: number | null;
  low_52w: number | null;
  raw: any;
}

export async function shoonyaQuote(
  ctx: ShoonyaCtx,
  token: string,
  exchange: string,
): Promise<ShoonyaQuote> {
  const exch = norenExchange(exchange);
  const q = await shoonyaPost<any>(ctx.base, "GetQuotes", { uid: ctx.uid, exch, token: String(token) }, ctx.jKey);
  return {
    symbol: appSymbol(q?.tsym),
    exchange: exch,
    price: num(q?.lp),
    previous_close: numOrNull(q?.c),
    day_open: numOrNull(q?.o),
    day_high: numOrNull(q?.h),
    day_low: numOrNull(q?.l),
    volume: numOrNull(q?.v),
    high_52w: numOrNull(q?.["52wk_high"] ?? q?.h52 ?? q?.yh),
    low_52w: numOrNull(q?.["52wk_low"] ?? q?.l52 ?? q?.yl),
    raw: q,
  };
}

export interface ShoonyaDepth {
  bids: Array<{ price: number; qty: number; orders: number }>;
  asks: Array<{ price: number; qty: number; orders: number }>;
  ltp: number | null;
}

export function depthFromQuote(q: any): ShoonyaDepth {
  const level = (side: "b" | "s", i: number) => ({
    price: num(q?.[`${side}p${i}`]),
    qty: num(q?.[`${side}q${i}`]),
    orders: num(q?.[`${side}o${i}`]),
  });
  const rows = [1, 2, 3, 4, 5];
  return {
    bids: rows.map((i) => level("b", i)).filter((r) => r.price > 0),
    asks: rows.map((i) => level("s", i)).filter((r) => r.price > 0),
    ltp: numOrNull(q?.lp),
  };
}

// -------------------------------------------------------------- candles

/** App interval -> TPSeries `intrv` minutes. Null means "use EOD chart data". */
export function norenInterval(interval: string): string | null {
  const map: Record<string, string> = {
    "1m": "1", "3m": "3", "5m": "5", "10m": "10", "15m": "15",
    "30m": "30", "60m": "60", "1h": "60", "4h": "240", "240m": "240",
  };
  return map[String(interval).toLowerCase()] ?? null;
}

/** "dd-mm-yyyy HH:MM:SS" (IST) -> epoch seconds. */
export function parseNorenTime(value: string): number {
  const m = String(value).match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const [, d, mo, y, hh, mm, ss] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss) - (5 * 60 + 30) * 60_000;
  return Math.floor(utcMs / 1000);
}

/** "dd-MMM-yyyy" (EOD chart data) -> epoch seconds at IST midnight. */
export function parseNorenDate(value: string): number {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const m = String(value).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
  }
  const mo = months.indexOf(m[2].toUpperCase());
  if (mo < 0) return 0;
  return Math.floor((Date.UTC(+m[3], mo, +m[1]) - (5 * 60 + 30) * 60_000) / 1000);
}

/** Intraday bars. Noren returns newest-first; we return oldest-first. */
export async function shoonyaIntradayCandles(
  ctx: ShoonyaCtx,
  token: string,
  exchange: string,
  intervalMinutes: string,
  fromSec: number,
  toSec: number,
): Promise<Candle[]> {
  const rows = await shoonyaPost<any[]>(ctx.base, "TPSeries", {
    uid: ctx.uid,
    exch: norenExchange(exchange),
    token: String(token),
    st: String(Math.floor(fromSec)),
    et: String(Math.floor(toSec)),
    intrv: intervalMinutes,
  }, ctx.jKey);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: any) => ({
      time: parseNorenTime(r?.time),
      open: num(r?.into),
      high: num(r?.inth),
      low: num(r?.intl),
      close: num(r?.intc),
      volume: num(r?.intv ?? r?.v),
    }))
    .filter((c) => c.time > 0 && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

/** Daily bars. `EODChartData` rows come back as JSON *strings*. */
export async function shoonyaDailyCandles(
  ctx: ShoonyaCtx,
  symbol: string,
  exchange: string,
  fromSec: number,
  toSec: number,
): Promise<Candle[]> {
  const rows = await shoonyaPost<any[]>(ctx.base, "EODChartData", {
    uid: ctx.uid,
    sym: `${norenExchange(exchange)}:${norenTradingSymbol(symbol, exchange)}`,
    from: String(Math.floor(fromSec)),
    to: String(Math.floor(toSec)),
  }, ctx.jKey);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row: any) => {
      const r = typeof row === "string" ? safeJson(row) : row;
      if (!r) return null;
      return {
        time: parseNorenDate(r.time ?? r.ssboe ?? ""),
        open: num(r.into),
        high: num(r.inth),
        low: num(r.intl),
        close: num(r.intc),
        volume: num(r.intv ?? r.intvwap ?? 0),
      };
    })
    .filter((c): c is Candle => !!c && c.time > 0 && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

function safeJson(text: string): any | null {
  try { return JSON.parse(text); } catch { return null; }
}

// ------------------------------------------------------- account surfaces

export interface ShoonyaHolding {
  symbol: string;
  exchange: string;
  quantity: number;
  avg_price: number;
  settled_qty: number | null;
  t1_qty: number | null;
  pledged_qty: number | null;
}

export async function shoonyaHoldings(ctx: ShoonyaCtx, product = "C"): Promise<{ rows: ShoonyaHolding[]; complete: boolean }> {
  let raw: any;
  try {
    raw = await shoonyaPost<any>(ctx.base, "Holdings", { uid: ctx.uid, actid: ctx.actid, prd: product }, ctx.jKey);
  } catch (e) {
    // Noren answers an empty book with `Not_Ok / "no data"` rather than [].
    if (e instanceof ShoonyaError && /no\s*data/i.test(e.message)) return { rows: [], complete: true };
    throw e;
  }
  const list: any[] = Array.isArray(raw) ? raw : [];
  const rows: ShoonyaHolding[] = [];
  for (const h of list) {
    const leg = (h?.exch_tsym ?? []).find((x: any) => norenExchange(x?.exch ?? "NSE") === "NSE") ?? (h?.exch_tsym ?? [])[0];
    if (!leg) continue;
    const settled = num(h?.holdqty) + num(h?.dpqty) + num(h?.benqty);
    const t1 = num(h?.npoadqty) + num(h?.btstqty);
    const pledged = num(h?.brkcolqty) + num(h?.unplgdqty === undefined ? 0 : 0);
    const quantity = settled + t1 + pledged;
    if (quantity <= 0) continue;
    rows.push({
      symbol: appSymbol(leg?.tsym),
      exchange: norenExchange(leg?.exch ?? "NSE"),
      quantity,
      avg_price: num(h?.upldprc),
      settled_qty: settled || null,
      t1_qty: t1 || null,
      pledged_qty: pledged || null,
    });
  }
  return { rows, complete: true };
}

export interface ShoonyaPosition {
  symbol: string;
  exchange: string;
  side: "long" | "short";
  quantity: number;
  entry_price: number;
  product: "MIS" | "CNC" | "NRML" | null;
}

export interface ShoonyaRealized {
  symbol: string;
  exchange: string;
  quantity: number;
  realized: number;
}

export async function shoonyaPositions(
  ctx: ShoonyaCtx,
): Promise<{ rows: ShoonyaPosition[]; realized: ShoonyaRealized[]; complete: boolean }> {
  let raw: any;
  try {
    raw = await shoonyaPost<any>(ctx.base, "PositionBook", { uid: ctx.uid, actid: ctx.actid }, ctx.jKey);
  } catch (e) {
    if (e instanceof ShoonyaError && /no\s*data/i.test(e.message)) return { rows: [], realized: [], complete: true };
    throw e;
  }
  const list: any[] = Array.isArray(raw) ? raw : [];
  const rows: ShoonyaPosition[] = [];
  const realized: ShoonyaRealized[] = [];
  for (const p of list) {
    const symbol = appSymbol(p?.tsym);
    if (!symbol) continue;
    const exchange = norenExchange(p?.exch ?? "NSE");
    const net = num(p?.netqty);
    const rpnl = num(p?.rpnl);
    if (net === 0) {
      const closed = Math.min(num(p?.daybuyqty), num(p?.daysellqty));
      if (closed > 0 || rpnl !== 0) realized.push({ symbol, exchange, quantity: closed, realized: rpnl });
      continue;
    }
    rows.push({
      symbol,
      exchange,
      side: net > 0 ? "long" : "short",
      quantity: Math.abs(net),
      entry_price: num(p?.netavgprc ?? p?.netupldprc ?? p?.upldprc),
      product: NOREN_TO_PRODUCT[String(p?.prd ?? "").toUpperCase()] ?? null,
    });
    if (rpnl !== 0) realized.push({ symbol, exchange, quantity: Math.min(num(p?.daybuyqty), num(p?.daysellqty)), realized: rpnl });
  }
  return { rows, realized, complete: true };
}

export interface ShoonyaFunds {
  net_cash: number | null;
  available_margin: number | null;
  used_margin: number | null;
  collateral: number | null;
  payin_amount: number | null;
  cash_balance: number | null;
  payout_amount: number | null;
  span_margin: number | null;
  exposure_margin: number | null;
  realized_mtm: number | null;
  unrealized_mtm: number | null;
  raw: any;
}

export async function shoonyaLimits(ctx: ShoonyaCtx): Promise<ShoonyaFunds> {
  const raw = await shoonyaPost<any>(ctx.base, "Limits", { uid: ctx.uid, actid: ctx.actid }, ctx.jKey);
  const l = Array.isArray(raw) ? raw[0] : raw;
  const cash = num(l?.cash);
  const payin = num(l?.payin);
  const collateral = num(l?.brkcollamt) + num(l?.collateral);
  const used = num(l?.marginused);
  const available = cash + payin + collateral - used;
  return {
    net_cash: cash + payin,
    available_margin: available,
    used_margin: used || null,
    collateral: collateral || null,
    payin_amount: payin || null,
    cash_balance: cash || null,
    payout_amount: numOrNull(l?.payout),
    span_margin: numOrNull(l?.span),
    exposure_margin: numOrNull(l?.expo),
    realized_mtm: numOrNull(l?.rpnl),
    unrealized_mtm: numOrNull(l?.unmtom ?? l?.urmtom),
    raw: l,
  };
}

export async function shoonyaOrderBook(ctx: ShoonyaCtx): Promise<any[]> {
  try {
    const raw = await shoonyaPost<any>(ctx.base, "OrderBook", { uid: ctx.uid, actid: ctx.actid }, ctx.jKey);
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    if (e instanceof ShoonyaError && /no\s*data/i.test(e.message)) return [];
    throw e;
  }
}

export async function shoonyaTradeBook(ctx: ShoonyaCtx): Promise<any[]> {
  try {
    const raw = await shoonyaPost<any>(ctx.base, "TradeBook", { uid: ctx.uid, actid: ctx.actid }, ctx.jKey);
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    if (e instanceof ShoonyaError && /no\s*data/i.test(e.message)) return [];
    throw e;
  }
}

export async function shoonyaSearchScrip(ctx: ShoonyaCtx, text: string, exchange = "NSE"): Promise<any[]> {
  const res = await shoonyaPost<any>(ctx.base, "SearchScrip", {
    uid: ctx.uid, stext: text, exch: norenExchange(exchange),
  }, ctx.jKey);
  return Array.isArray(res?.values) ? res.values : [];
}

// ---------------------------------------------------------------- orders

export interface ShoonyaOrderInput {
  symbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: "MARKET" | "LIMIT" | "SL" | "SL-M";
  product: "MIS" | "CNC" | "NRML";
  price?: number;
  triggerPrice?: number;
  validity?: "DAY" | "IOC";
  disclosedQuantity?: number;
  amo?: boolean;
}

export async function shoonyaPlaceOrder(ctx: ShoonyaCtx, input: ShoonyaOrderInput): Promise<{ orderId: string; status: string }> {
  const res = await shoonyaPost<any>(ctx.base, "PlaceOrder", {
    uid: ctx.uid,
    actid: ctx.actid,
    exch: norenExchange(input.exchange),
    tsym: norenTradingSymbol(input.symbol, input.exchange),
    qty: String(Math.max(1, Math.floor(input.quantity))),
    prc: String(input.price ?? 0),
    trgprc: input.triggerPrice !== undefined ? String(input.triggerPrice) : undefined,
    dscqty: String(input.disclosedQuantity ?? 0),
    prd: PRODUCT_TO_NOREN[input.product] ?? "I",
    trantype: input.side === "SELL" ? "S" : "B",
    prctyp: ORDER_TYPE_TO_NOREN[input.orderType] ?? "MKT",
    ret: input.validity ?? "DAY",
    ordersource: "API",
    ...(input.amo ? { amo: "Yes" } : {}),
  }, ctx.jKey);
  return { orderId: String(res?.norenordno ?? ""), status: String(res?.request_time ? "submitted" : res?.stat ?? "submitted") };
}

export async function shoonyaModifyOrder(
  ctx: ShoonyaCtx,
  orderId: string,
  current: { symbol: string; exchange: string },
  changes: { quantity?: number; price?: number; orderType?: "MARKET" | "LIMIT" | "SL" | "SL-M"; triggerPrice?: number; validity?: "DAY" | "IOC" },
): Promise<{ orderId: string; status: string }> {
  const res = await shoonyaPost<any>(ctx.base, "ModifyOrder", {
    uid: ctx.uid,
    norenordno: orderId,
    exch: norenExchange(current.exchange),
    tsym: norenTradingSymbol(current.symbol, current.exchange),
    ...(changes.quantity !== undefined ? { qty: String(changes.quantity) } : {}),
    ...(changes.price !== undefined ? { prc: String(changes.price) } : {}),
    ...(changes.triggerPrice !== undefined ? { trgprc: String(changes.triggerPrice) } : {}),
    ...(changes.orderType ? { prctyp: ORDER_TYPE_TO_NOREN[changes.orderType] } : {}),
    ...(changes.validity ? { ret: changes.validity } : {}),
  }, ctx.jKey);
  return { orderId: String(res?.result ?? orderId), status: "modified" };
}

export async function shoonyaCancelOrder(ctx: ShoonyaCtx, orderId: string): Promise<{ orderId: string; status: string }> {
  const res = await shoonyaPost<any>(ctx.base, "CancelOrder", { uid: ctx.uid, norenordno: orderId }, ctx.jKey);
  return { orderId: String(res?.result ?? orderId), status: "cancelled" };
}

export async function shoonyaConvertPosition(ctx: ShoonyaCtx, input: {
  symbol: string; exchange: string; side: "BUY" | "SELL"; quantity: number;
  fromProduct: "MIS" | "CNC" | "NRML"; toProduct: "MIS" | "CNC" | "NRML";
}): Promise<{ ok: true }> {
  await shoonyaPost<any>(ctx.base, "ProductConversion", {
    uid: ctx.uid,
    actid: ctx.actid,
    exch: norenExchange(input.exchange),
    tsym: norenTradingSymbol(input.symbol, input.exchange),
    qty: String(input.quantity),
    prd: PRODUCT_TO_NOREN[input.toProduct] ?? "I",
    prevprd: PRODUCT_TO_NOREN[input.fromProduct] ?? "I",
    trantype: input.side === "SELL" ? "S" : "B",
    postype: "DAY",
  }, ctx.jKey);
  return { ok: true };
}