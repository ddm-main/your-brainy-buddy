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

async function kotakFetch(url: string, init: RequestInit): Promise<any> {
  const r = await fetch(url, init);
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
  const hsServerId = validate?.data?.hsServerId ?? login?.data?.hsServerId ?? "";
  const baseUrl = String(validate?.data?.baseUrl ?? "").replace(/\/+$/, "");
  if (!editToken || !editSid) {
    throw new KotakError("Kotak validate: no session token", 502, JSON.stringify(validate).slice(0, 500));
  }
  if (!baseUrl) {
    throw new KotakError("Kotak validate: no baseUrl in response", 502, JSON.stringify(validate).slice(0, 500));
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
export async function kotakAutoLogin(s: KotakSettings): Promise<KotakSession> {
  const secret = await dec(s.totp_secret_enc);
  if (!secret) throw new KotakError("TOTP secret not configured", 400);
  const code = await totp(secret);
  return kotakLogin(s, code);
}

async function sessionHeaders(s: KotakSettings): Promise<Record<string, string>> {
  const editToken = await dec(s.session_token_enc);
  if (!editToken || !s.sid) throw new KotakError("No active Kotak session", 401);
  return {
    Authorization: s.consumer_key ?? "",
    Auth: editToken,
    Sid: s.sid,
    accept: "*/*",
  };
}

export async function kotakHoldings(s: KotakSettings): Promise<any[]> {
  const h = await sessionHeaders(s);
  const j = await kotakFetch(`${apiBase(s)}/portfolio/v1/holdings`, { headers: h });
  return j?.data ?? [];
}

export async function kotakPositions(s: KotakSettings): Promise<any[]> {
  const h = await sessionHeaders(s);
  const j = await kotakFetch(`${apiBase(s)}/quick/user/positions`, { headers: h });
  return j?.data ?? [];
}

export async function kotakLimits(s: KotakSettings): Promise<any> {
  const h = await sessionHeaders(s);
  return kotakFetch(`${apiBase(s)}/quick/user/limits`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ seg: "ALL", exch: "ALL", prod: "ALL" }),
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
export async function withKotakSession<T>(
  svc: SupabaseClient,
  s: KotakSettings,
  encrypt: (v: string) => Promise<string>,
  fn: (s: KotakSettings) => Promise<T>,
): Promise<T> {
  try {
    return await fn(s);
  } catch (e) {
    if (e instanceof KotakError && (e.status === 401 || e.status === 403) && s.totp_secret_enc) {
      const sess = await kotakAutoLogin(s);
      await persistSession(svc, s, sess, encrypt);
      const fresh: KotakSettings = {
        ...s,
        sid: sess.editSid,
        hs_server_id: sess.hsServerId,
        session_token_enc: await encrypt(sess.editToken),
      };
      return await fn(fresh);
    }
    if (e instanceof KotakError && (e.status === 401 || e.status === 403)) {
      await svc
        .from("market_api_settings")
        .update({ connection_status: "expired", last_error: "Session expired — re-login required" })
        .eq("id", s.id);
    }
    throw e;
  }
}
