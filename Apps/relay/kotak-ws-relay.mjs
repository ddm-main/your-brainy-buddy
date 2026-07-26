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
// A socket that opens and is immediately closed again (stale/expired Kotak
// session rejected at the auth-frame level, gateway hiccup) must NOT reset
// backoff to base — that produces a hot reconnect loop hammering Kotak's WS
// endpoint every ~2s indefinitely, which is exactly the pattern brokers
// rate-limit or lock accounts for. Only a connection that stayed open this
// long, or received real traffic, counts as "healthy" for backoff purposes.
const SUSTAINED_CONNECTION_MS = 10_000;

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
  "id,user_id,consumer_key,base_url,ws_url,ucc,session_token_enc,sid,hs_server_id,connection_status,token_expires_at,totp_secret_enc,is_system";

async function fetchKotakSession() {
  // Bind to the designated system market-data feed
  // (market_api_settings.is_system) so ticks don't silently follow whichever
  // user reconnected last. Falls back to the newest connected Kotak row when
  // no feed has been designated yet.
  const pick = async (q) => {
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? [])[0] ?? null;
  };
  let data = await pick(
    svc.from("market_api_settings").select(SETTINGS_COLS)
      .eq("active_provider", "kotak_neo").eq("is_system", true).limit(1),
  );
  if (!data || data.connection_status !== "connected") {
    const fallback = await pick(
      svc.from("market_api_settings").select(SETTINGS_COLS)
        .eq("active_provider", "kotak_neo").eq("connection_status", "connected")
        .order("updated_at", { ascending: false }).limit(1),
    );
    if (fallback) data = fallback;
  }
  if (!data || data.connection_status !== "connected") return null;
  log(`bound to ${data.is_system ? "system" : "fallback"} feed · ucc=${data.ucc ?? "?"}`);
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

// Kotak Neo NSE index instrument tokens on the nse_cm channel. Kept as a
// small static map because these tokens are effectively immutable and are
// not present in market_stocks (which is equities-only). Without these the
// MarketStrip index chips never receive push ticks and only move at the
// 1s REST cadence — this is what makes NIFTY/BANKNIFTY/VIX feel realtime.
// SENSEX lives on bse_cm and Kotak's index feed for it is unreliable via
// this WS, so we leave it on REST-only.
const INDEX_TOKEN_MAP = [
  { token: "26000", symbol: "^NSEI" },     // NIFTY 50
  { token: "26009", symbol: "^NSEBANK" },  // NIFTY BANK
  { token: "26017", symbol: "^INDIAVIX" }, // INDIA VIX
];

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
  for (const idx of INDEX_TOKEN_MAP) {
    bySymbol.set(idx.symbol, idx.token);
    byToken.set(idx.token, idx.symbol);
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
      let healthy = false;
      try {
        healthy = await this.connectOnce();
      } catch (e) {
        log("connection attempt failed:", e.message);
      }
      if (this.stopped) break;
      const delay = this.reconnectDelay;
      log(`reconnecting in ${Math.round(delay / 1000)}s…`);
      await new Promise((r) => setTimeout(r, delay));
      // Only a sustained/healthy connection resets backoff to base — an
      // open-then-immediately-closed cycle keeps growing it instead of
      // hot-looping. See SUSTAINED_CONNECTION_MS above.
      this.reconnectDelay = healthy ? RECONNECT_BASE_MS : Math.min(this.reconnectDelay * 1.7, RECONNECT_MAX_MS);
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
      await this.channel.subscribe((status) => {
        log("broadcast channel:", status);
        // Handshake so the UI can flip the chip to "push · kotak" immediately,
        // without waiting for the first tick on a thin symbol.
        if (status === "SUBSCRIBED") {
          this.channel?.send({ type: "broadcast", event: "hello", payload: { relay: "kotak-ws", ts: Date.now() } })
            .catch((e) => log("hello broadcast failed:", e?.message ?? e));
        }
      });
      // Clients (Dashboard, screener, watchlist) broadcast the union of
      // on-screen symbols on `subscribe`. We're already SCRIP_SUBSed to the
      // full universe on connect, so we just re-emit hello to confirm the
      // relay is up and the caller can expect push ticks.
      this.channel.on("broadcast", { event: "subscribe" }, () => {
        this.channel?.send({ type: "broadcast", event: "hello", payload: { relay: "kotak-ws", ts: Date.now() } })
          .catch(() => { /* channel closing */ });
      });
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(session.wsUrl);
      this.ws = ws;
      let settled = false;
      let openedAt = null;
      let sawTraffic = false;
      const resetSilence = () => {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = setTimeout(() => {
          log("no messages for", SILENCE_TIMEOUT_MS / 1000, "s — assuming connection is dead, forcing reconnect");
          ws.close();
        }, SILENCE_TIMEOUT_MS);
      };

      ws.addEventListener("open", () => {
        openedAt = Date.now();
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
        sawTraffic = true;
        resetSilence();
        this.handleMessage(ev.data);
      });

      ws.addEventListener("error", (ev) => {
        log("socket error:", ev.message ?? ev);
      });

      ws.addEventListener("close", (ev) => {
        clearTimeout(this.silenceTimer);
        clearInterval(this.heartbeatTimer);
        const openMs = openedAt ? Date.now() - openedAt : 0;
        const healthy = sawTraffic || openMs >= SUSTAINED_CONNECTION_MS;
        log(`socket closed (code ${ev.code}) after ${Math.round(openMs / 1000)}s${healthy ? "" : " — not sustained, backing off"}`);
        if (!settled) { settled = true; resolve(healthy); }
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
      // Ticks fire many times a second; an unhandled rejection here (channel
      // briefly erroring/closing mid-tick) would crash the whole process by
      // Node's default behavior, cutting live ticks for every user until the
      // supervisor's restart timer fires. Log and drop the tick instead.
    })?.catch((e) => log("tick broadcast failed:", e?.message ?? e));
  }
}

const supervisor = new Supervisor();
process.on("SIGINT", () => { log("shutting down…"); supervisor.stop(); process.exit(0); });
process.on("SIGTERM", () => { log("shutting down…"); supervisor.stop(); process.exit(0); });

log("starting Kotak Neo live-tick relay");
await supervisor.start();
