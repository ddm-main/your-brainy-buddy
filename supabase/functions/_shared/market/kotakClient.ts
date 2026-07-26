// Kotak Neo v2 (TOTP flow) API client. The consumer key is the bearer credential.
// Docs: github.com/Kotak-Neo/kotak-neo-api-v2. Tokens die daily (~midnight IST);
// with an encrypted TOTP secret + MPIN stored we can re-login unattended.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decryptStatementPassword, type StatementPasswordRule } from "../crypto.ts";
import { totp } from "./totp.ts";

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

// rate_limit column on market_api_settings documents the user's Kotak tier
// but nothing enforces it client-side — Kotak's APIM gateway is the actual
// throttle. On 429, back off and retry rather than surfacing an error (the
// only place in this backend besides yahooClient.ts that needs this).
async function kotakFetch(url: string, init: RequestInit, attempt = 1): Promise<any> {
  const r = await fetch(url, init);
  if (r.status === 429 && attempt <= 2) {
    const retryAfterSec = Number(r.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : 400 * attempt;
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

  const mobileNumber = mobile.startsWith("+") ? mobile : `+91${mobile.replace(/^0+/, "")}`;

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
    throw new KotakError("Kotak login: no token in response", 502, JSON.stringify(login).slice(0, 500));
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
  // Kotak's MPIN validate payload often includes hsServerId as an empty
  // string, while the preceding TOTP login payload carries the real server
  // id (server2/server4/etc.). Using `??` here persisted "" and dropped the
  // required `sId` query param from order/trade/position calls, which Kotak
  // can surface as a misleading 404. Always pick the first non-empty value.
  const hsServerId = firstNonEmpty(validate?.data?.hsServerId, login?.data?.hsServerId);
  const baseUrl = firstNonEmpty(validate?.data?.baseUrl).replace(/\/+$/, "");
  if (!editToken || !editSid) {
    throw new KotakError("Kotak validate: no session token", 502, JSON.stringify(validate).slice(0, 500));
  }
  if (!baseUrl) {
    throw new KotakError("Kotak validate: no baseUrl in response", 502, JSON.stringify(validate).slice(0, 500));
  }
  if (!hsServerId) {
    throw new KotakError("Kotak validate: no hsServerId in response", 502, JSON.stringify({ login, validate }).slice(0, 500));
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
// apply. Runs at most once/day per user (market-kotak-refresh cron), so the
// extra attempts on a real failure are negligible.
export async function kotakAutoLogin(s: KotakSettings): Promise<KotakSession> {
  const secret = await dec(s.totp_secret_enc);
  if (!secret) throw new KotakError("TOTP secret not configured", 400);
  const now = Date.now();
  let lastErr: unknown;
  for (const offsetMs of [0, -30_000, 30_000]) {
    try {
      const code = await totp(secret, { timeMs: now + offsetMs });
      return await kotakLogin(s, code);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function sessionHeaders(s: KotakSettings): Promise<Record<string, string>> {
  const editToken = await dec(s.session_token_enc);
  if (!editToken || !s.sid) throw new KotakError("No active Kotak session", 401);
  return {
    Auth: editToken,
    Sid: s.sid,
    accept: "*/*",
  };
}

function appendSId(s: KotakSettings): string {
  return s.hs_server_id ? `?sId=${encodeURIComponent(s.hs_server_id)}` : "";
}

function requireServerId(s: KotakSettings): void {
  if (!String(s.hs_server_id ?? "").trim()) {
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
export async function kotakHoldingsEnvelope(s: KotakSettings): Promise<{ rows: any[]; ok: boolean; raw: any }> {
  const h = await sessionHeaders(s);
  const j = await kotakFetch(`${apiBase(s)}/portfolio/v1/holdings`, { headers: h });
  const rows = Array.isArray(j?.data) ? j.data : [];
  const stat = String(j?.stat ?? j?.stCode ?? "").toLowerCase();
  const ok = stat === "ok" || (stat === "" && Array.isArray(j?.data));
  return { rows, ok, raw: j };
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
  const rows = Array.isArray(j?.data) ? j.data : [];
  const stat = String(j?.stat ?? j?.stCode ?? "").toLowerCase();
  const ok = stat === "ok" || (stat === "" && Array.isArray(j?.data));
  return { rows, ok, raw: j };
}

export async function kotakLimits(s: KotakSettings): Promise<any> {
  requireServerId(s);
  const h = await sessionHeaders(s);
  // /quick/user/limits intermittently returns 5xx / empty bodies when queried
  // with {ALL,ALL,ALL} on cash-only Neo accounts. Try the concrete cash combo
  // first (what most retail accounts have), fall back to the broadcast query,
  // and treat empty bodies as "combo not applicable" — advance rather than
  // burn the whole attempt.
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
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

// Fallback margin endpoint. Neo web uses /quick/user/margin as an alternative
// to /quick/user/limits — it returns the same shape (Net / CashAvailable /
// MarginUsed / Collateral) but is more reliable on cash-only accounts.
export async function kotakUserMargin(s: KotakSettings): Promise<any> {
  requireServerId(s);
  const h = await sessionHeaders(s);
  return await kotakRouteFetch(s, ["quick/user/margin", "Orders/2.0/quick/user/margin"], {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ seg: "CASH", exch: "NSE", prod: "ALL" }),
  });
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
export async function kotakCandles(
  s: KotakSettings,
  instrumentToken: string,
  exchangeSegment: string, // "nse_cm" | "bse_cm" | "nse_fo"
  fromEpoch: number,
  toEpoch: number,
  interval: string,
): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
  const h = await sessionHeaders(s);
  const body = {
    exch: exchangeSegment.startsWith("bse") ? "BSE" : exchangeSegment.startsWith("nse_fo") ? "NFO" : "NSE",
    token: String(instrumentToken),
    fromDate: String(fromEpoch),
    toDate: String(toEpoch),
    interval,
  };
  const j = await kotakFetch(`${apiBase(s)}/charts/v2/history`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
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
export async function kotakDepth(
  s: KotakSettings,
  instrumentToken: string,
  exchangeSegment = "nse_cm",
): Promise<{ bids: Array<{ price: number; qty: number; orders: number }>; asks: Array<{ price: number; qty: number; orders: number }>; ltp: number | null } | null> {
  const h = await sessionHeaders(s);
  const neoSym = `${exchangeSegment}|${instrumentToken}`;
  const path = encodeURIComponent(neoSym);
  const j = await kotakFetch(
    `${apiBase(s)}/script-details/1.0/quotes/neosymbol/${path}/depth`,
    { headers: { ...h, accept: "application/json" } },
  );
  const d = Array.isArray(j?.data) ? j.data[0] : (j?.data ?? j);
  if (!d) return null;
  const bidsRaw = d.bids ?? d.bid ?? d.buy ?? [];
  const asksRaw = d.asks ?? d.ask ?? d.sell ?? [];
  const toRow = (r: any) => ({
    price: Number(r.price ?? r.p ?? 0),
    qty: Number(r.quantity ?? r.qty ?? r.q ?? 0),
    orders: Number(r.orders ?? r.n ?? 0),
  });
  return {
    bids: (Array.isArray(bidsRaw) ? bidsRaw : []).map(toRow).filter((r) => r.price > 0).slice(0, 5),
    asks: (Array.isArray(asksRaw) ? asksRaw : []).map(toRow).filter((r) => r.price > 0).slice(0, 5),
    ltp: Number(d.last_traded_price ?? d.ltp ?? 0) || null,
  };
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

function orderBody(input: PlaceOrderInput) {
  const needsTrigger = input.orderType === "SL" || input.orderType === "SL-M";
  const needsPrice = input.orderType === "LIMIT" || input.orderType === "SL";
  return {
    exchange_segment: input.exchangeSegment,
    product: input.product,
    order_type: kotakOrderTypeCode(input.orderType),
    price: needsPrice ? String(input.price ?? 0) : "0",
    quantity: String(input.quantity),
    validity: input.validity ?? "DAY",
    trading_symbol: input.tradingSymbol,
    transaction_type: input.transactionType === "BUY" ? "B" : "S",
    amo: input.amo ? "YES" : "NO",
    disclosed_quantity: String(input.disclosedQuantity ?? 0),
    market_protection: "0",
    pf: "N",
    trigger_price: needsTrigger ? String(input.triggerPrice ?? 0) : "0",
    ...(input.instrumentToken ? { scrip_token: input.instrumentToken } : {}),
  };
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
  const snap: KotakFundsSnapshot = {
    net_cash: pickNum(["Net", "net", "netCash", "NetCash"]),
    available_margin: pickNum(["CashAvailable", "cashAvailable", "AvailableMargin", "availableMargin", "MarginAvailable", "marginAvailable", "AvlblCash", "avlblCash"]),
    used_margin: pickNum(["MarginUsed", "marginUsed", "MarginUtilized", "marginUtilized", "Utilised", "utilised", "MarginUtilised", "marginUtilised"]),
    collateral: pickNum(["Collateral", "collateral", "CollateralAmount", "collateralAmount", "CollateralValue", "collateralValue"]),
    payin_amount: pickNum(["Payin", "payin", "PayIn", "payIn", "PayinAmount", "payinAmount"]),
    cash_balance: pickNum(["Cash", "cash", "CashBalance", "cashBalance", "OpeningBalance", "openingBalance"]),
    payout_amount: pickNum(["Payout", "payout", "PayOut", "payOut", "PayoutAmount", "payoutAmount"]),
    span_margin: pickNum(["SPAN", "span", "SpanMargin", "spanMargin"]),
    exposure_margin: pickNum(["Exposure", "exposure", "ExposureMargin", "exposureMargin"]),
    realized_mtm: pickNum(["Realized", "realized", "RealisedMtoM", "realisedMtoM", "RealisedPnL", "realisedPnL"]),
    unrealized_mtm: pickNum(["Unrealized", "unrealized", "UnrealisedMtoM", "unrealisedMtoM", "UnrealisedPnL", "unrealisedPnL", "MtoM", "mtoM"]),
    raw: d,
  };
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


export async function kotakPlaceOrder(s: KotakSettings, input: PlaceOrderInput): Promise<KotakOrderResult> {
  const h = await sessionHeaders(s);
  const j = await kotakFetch(`${apiBase(s)}/quick/order/rule/ms/place`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify(orderBody(input)),
  });
  const orderId = String(j?.nOrdNo ?? j?.data?.nOrdNo ?? j?.orderId ?? "");
  const status = String(j?.stat ?? j?.stCode ?? "");
  if (!orderId) throw new KotakError("Kotak place order: no order id in response", 502, JSON.stringify(j).slice(0, 500));
  return { orderId, status, raw: j };
}

export async function kotakCancelOrder(s: KotakSettings, orderId: string): Promise<KotakOrderResult> {
  const h = await sessionHeaders(s);
  const j = await kotakFetch(`${apiBase(s)}/quick/order/rule/ms/cancel`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId }),
  });
  return { orderId, status: String(j?.stat ?? j?.stCode ?? ""), raw: j };
}

export async function kotakModifyOrder(
  s: KotakSettings,
  orderId: string,
  changes: Partial<Pick<PlaceOrderInput, "quantity" | "price" | "orderType" | "triggerPrice" | "validity">>,
): Promise<KotakOrderResult> {
  const h = await sessionHeaders(s);
  const body: Record<string, string> = { order_id: orderId };
  if (changes.quantity != null) body.quantity = String(changes.quantity);
  if (changes.price != null) body.price = String(changes.price);
  if (changes.triggerPrice != null) body.trigger_price = String(changes.triggerPrice);
  if (changes.validity) body.validity = changes.validity;
  if (changes.orderType) body.order_type = kotakOrderTypeCode(changes.orderType);
  const j = await kotakFetch(`${apiBase(s)}/quick/order/rule/ms/modify`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  await svc
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
  // reflect in the in-memory object so follow-up calls in the same invocation work
  s.sid = sess.editSid;
  s.hs_server_id = sess.hsServerId;
  s.base_url = sess.apiBase;
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
  reloginLocks.set(settingsId, prev.then(() => gate));
  try { await prev; return await fn(); }
  finally { release(); if (reloginLocks.get(settingsId) === gate) reloginLocks.delete(settingsId); }
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
    if (!(e instanceof KotakError) || (e.status !== 401 && e.status !== 403)) throw e;
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
          && String(latest.hs_server_id ?? "").trim()) {
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
      return await fn(fresh);
    }
    await svc
      .from("market_api_settings")
      .update({ connection_status: "expired", last_error: "Session expired — re-login required" })
      .eq("id", s.id);
    if (!retryOnAuthError) {
      throw new KotakAmbiguousOrderError(
        "Kotak session expired mid-request — this order may or may not have reached the broker. Check Orders/Trades before resubmitting; do not retry blindly. Reconnect Kotak in Market → Config once verified.",
        e.status, e.body,
      );
    }
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
  const j = await kotakFetch(`${apiBase(s)}/quick/order/rule/ms/pos-conversion`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: String(j?.stat ?? j?.stCode ?? ""), raw: j };
}
