#!/usr/bin/env node
// Kotak Neo live-tick relay — the persistent process a real trading feel
// needs. Supabase Edge Functions are stateless request/response and can't
// hold a live upstream connection; this small local Node process is that
// missing piece: one WebSocket to Kotak Neo, fanned out to every open
// browser tab via a private Supabase Realtime broadcast channel.
//
// Run: npm run relay   (needs SUPABASE_SERVICE_ROLE_KEY + STATEMENT_ENC_SECRET
// in a local .env — see .env.example. Requires Kotak Neo connected in Settings.)
//
// Node 24+ required — this relies on native `WebSocket`, `crypto.subtle`, and
// direct `.ts` import support (no build step). See package.json engines.

import { createClient } from "@supabase/supabase-js";
import { decryptStatementPassword } from "../../supabase/functions/_shared/crypto.ts";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("[relay] Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — see .env.example.");
  process.exit(1);
}
if (!process.env.STATEMENT_ENC_SECRET) {
  console.error("[relay] Missing STATEMENT_ENC_SECRET (same value as the edge-function secret) — see .env.example.");
  process.exit(1);
}

const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const HEARTBEAT_MS = 25_000;
const SILENCE_TIMEOUT_MS = 45_000; // no message (incl. our own heartbeats' replies) => assume dead
const TOKEN_MAP_REFRESH_MS = 5 * 60_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

function log(...args) {
  console.log(`[relay ${new Date().toISOString()}]`, ...args);
}

async function dec(encJson) {
  if (!encJson) return null;
  return decryptStatementPassword(JSON.parse(encJson));
}

// The relay's own settings read — a superset of what kotakClient.ts needs
// server-side, plus ws_url (not modeled there since edge functions never
// open a socket themselves).
const SETTINGS_COLS =
  "id,user_id,consumer_key,base_url,ws_url,ucc,session_token_enc,sid,hs_server_id,connection_status,token_expires_at,totp_secret_enc";

async function fetchKotakSession() {
  const { data, error } = await svc
    .from("market_api_settings")
    .select(SETTINGS_COLS)
    .eq("active_provider", "kotak_neo")
    .eq("connection_status", "connected")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const editToken = await dec(data.session_token_enc);
  if (!editToken || !data.sid || !data.consumer_key) return null;
  return {
    userId: data.user_id,
    consumerKey: data.consumer_key,
    editToken,
    sid: data.sid,
    hsServerId: data.hs_server_id,
    wsUrl: data.ws_url || "wss://mlhsm.kotaksecurities.com",
  };
}

async function fetchTokenMap() {
  const { data, error } = await svc
    .from("market_stocks")
    .select("symbol,token")
    .eq("exchange", "NSE")
    .eq("in_universe", true)
    .not("token", "is", null);
  if (error) throw error;
  const bySymbol = new Map();
  const byToken = new Map();
  for (const row of data ?? []) {
    bySymbol.set(row.symbol, row.token);
    byToken.set(String(row.token), row.symbol);
  }
  return { bySymbol, byToken };
}

class Supervisor {
  constructor() {
    this.ws = null;
    this.channel = null;
    this.byToken = new Map();
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.silenceTimer = null;
    this.heartbeatTimer = null;
    this.tokenRefreshTimer = null;
    this.stopped = false;
  }

  async start() {
    this.tokenRefreshTimer = setInterval(() => {
      fetchTokenMap().then(({ byToken }) => { this.byToken = byToken; }).catch((e) => log("token refresh failed:", e.message));
    }, TOKEN_MAP_REFRESH_MS);
    await this.connectLoop();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.tokenRefreshTimer);
    clearTimeout(this.silenceTimer);
    clearInterval(this.heartbeatTimer);
    this.ws?.close();
  }

  async connectLoop() {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.reconnectDelay = RECONNECT_BASE_MS; // clean disconnect resets backoff
      } catch (e) {
        log("connection attempt failed:", e.message);
      }
      if (this.stopped) break;
      log(`reconnecting in ${Math.round(this.reconnectDelay / 1000)}s…`);
      await new Promise((r) => setTimeout(r, this.reconnectDelay));
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, RECONNECT_MAX_MS);
    }
  }

  // Resolves when the socket closes (cleanly or otherwise) so connectLoop can decide to retry.
  async connectOnce() {
    const session = await fetchKotakSession();
    if (!session) {
      log("Kotak not connected (or session expired) — waiting before retry. Open Settings and log in.");
      throw new Error("no active Kotak session");
    }
    const { byToken } = await fetchTokenMap();
    this.byToken = byToken;
    if (byToken.size === 0) {
      log("universe is empty — run 'Sync universe' in Settings first. Subscribing with 0 symbols.");
    }

    if (!this.channel) {
      this.channel = svc.channel(`market-ticks-${session.userId}`, { config: { private: true } });
      await this.channel.subscribe((status) => log("broadcast channel:", status));
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(session.wsUrl);
      this.ws = ws;
      let settled = false;
      const resetSilence = () => {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = setTimeout(() => {
          log("no messages for", SILENCE_TIMEOUT_MS / 1000, "s — assuming connection is dead, forcing reconnect");
          ws.close();
        }, SILENCE_TIMEOUT_MS);
      };

      ws.addEventListener("open", () => {
        log("connected to", session.wsUrl);
        ws.send(JSON.stringify({ type: "cn", Authorization: session.consumerKey, Sid: session.sid, Auth: session.editToken }));
        const tokens = [...byToken.keys()].map((tok) => `nse_cm|${tok}`);
        for (let i = 0; i < tokens.length; i += 200) {
          const chunk = tokens.slice(i, i + 200).join("&");
          ws.send(JSON.stringify({ type: "SCRIP_SUBS", scrips: chunk, channelnum: 1 }));
        }
        log(`subscribed to ${tokens.length} symbols`);
        this.heartbeatTimer = setInterval(() => {
          try { ws.send(JSON.stringify({ type: "hb" })); } catch { /* socket already closing */ }
        }, HEARTBEAT_MS);
        resetSilence();
      });

      ws.addEventListener("message", (ev) => {
        resetSilence();
        this.handleMessage(ev.data);
      });

      ws.addEventListener("error", (ev) => {
        log("socket error:", ev.message ?? ev);
      });

      ws.addEventListener("close", (ev) => {
        clearTimeout(this.silenceTimer);
        clearInterval(this.heartbeatTimer);
        log(`socket closed (code ${ev.code})`);
        if (!settled) { settled = true; resolve(); }
      });

      // In case `new WebSocket` itself throws asynchronously with no close event.
      setTimeout(() => {
        if (!settled && ws.readyState === WebSocket.CONNECTING) {
          settled = true;
          ws.close();
          reject(new Error("connect timeout"));
        }
      }, 15_000);
    });
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // Heartbeat/ack frames and anything without a token are not ticks.
    const tok = String(msg?.tk ?? "");
    if (!tok) return;
    const symbol = this.byToken.get(tok);
    if (!symbol) return;
    const ltp = Number(msg.ltp);
    if (!Number.isFinite(ltp) || ltp <= 0) return;
    const changePct = msg.nc != null ? Number(msg.nc) : msg.cng != null ? Number(msg.cng) : null;
    this.channel?.send({
      type: "broadcast",
      event: "tick",
      payload: { symbol, exchange: "NSE", ltp, change_pct: Number.isFinite(changePct) ? changePct : null },
    });
  }
}

const supervisor = new Supervisor();
process.on("SIGINT", () => { log("shutting down…"); supervisor.stop(); process.exit(0); });
process.on("SIGTERM", () => { log("shutting down…"); supervisor.stop(); process.exit(0); });

log("starting Kotak Neo live-tick relay");
await supervisor.start();
