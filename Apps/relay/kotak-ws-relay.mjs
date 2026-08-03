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
    .select("symbol,token,in_universe")
    .eq("exchange", "NSE")
    .eq("in_universe", true);
  if (error) throw error;
  const bySymbol = new Map();
  const byToken = new Map();
  let missing = 0;
  for (const row of data ?? []) {
    if (row.token == null) { missing += 1; continue; }
    bySymbol.set(row.symbol, row.token);
    byToken.set(String(row.token), row.symbol);
  }
  for (const idx of INDEX_TOKEN_MAP) {
    bySymbol.set(idx.symbol, idx.token);
    byToken.set(idx.token, idx.symbol);
  }
  if (missing > 0) {
    log(`WARN: ${missing} universe symbols have no Kotak token — those stocks will not receive push ticks. Run Settings → Sync universe.`);
  }
  return { bySymbol, byToken };
}


// Coalesce Kotak ticks into 100ms batches before broadcasting. A busy
// symbol can emit 20+ ticks per second; broadcasting each individually blew
// past Supabase Realtime's per-client send ceiling and dropped ticks
// silently. One batched `ticks` message per 100ms lets every symbol update
// keep flowing without hitting rate limits, and the client applies the
// batch in a single store write (see liveTickStore.applyTicks) so rendering
// cost is capped at ~10Hz regardless of tick volume.
const BROADCAST_FLUSH_MS = 100;
const BROADCAST_MAX_BATCH = 500;
const CANDLE_FLUSH_MS = 2_000;

// --- Depth (level-2) ------------------------------------------------------
// Depth is subscribed on demand, never for the whole universe: Kotak charges
// a separate, much heavier frame per instrument and only a couple of symbols
// are ever on screen at once (the A2 ladder on Analysis / IndexDetail).
// Clients broadcast `depth_subscribe` with the symbols they're showing and
// re-send it periodically; a symbol not renewed within DEPTH_LEASE_MS is
// DEPTH_UNSUBSed so a closed tab stops costing us frames.
const DEPTH_LEASE_MS = 90_000;
const DEPTH_MAX_SYMBOLS = 8;
const DEPTH_CHANNEL = 2;


class Supervisor {
  constructor() {
    this.ws = null;
    this.channel = null;
    this.byToken = new Map();
    this.bySymbol = new Map();
    // Per-token last-known change_pct. Kotak Neo sends bare-LTP delta frames
    // after the initial snapshot; without carrying the previous change_pct
    // forward, the UI's % column flickers to "—" between full frames.
    this.lastChangePct = new Map();
    // Buffer: symbol -> latest tick payload. Last write wins per symbol
    // within a flush window so a hot ticker doesn't crowd out others.
    this.tickBuffer = new Map();
    // symbol -> forming 1m Kotak candle. This is the authoritative source for
    // today's intraday chart bars; Yahoo is only historical/backfill.
    this.minuteBars = new Map();
    this.lastCumVolume = new Map();
    // token -> lease expiry epoch ms for depth subscriptions.
    this.depthLeases = new Map();
    this.flushTimer = null;
    this.candleFlushTimer = null;
    this.depthSweepTimer = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.silenceTimer = null;
    this.heartbeatTimer = null;
    this.tokenRefreshTimer = null;
    this.stopped = false;
  }


  async start() {
    this.tokenRefreshTimer = setInterval(() => {
      fetchTokenMap()
        .then(({ byToken, bySymbol }) => { this.byToken = byToken; this.bySymbol = bySymbol; })
        .catch((e) => log("token refresh failed:", e.message));
    }, TOKEN_MAP_REFRESH_MS);
    this.flushTimer = setInterval(() => this.flushTicks(), BROADCAST_FLUSH_MS);
    this.candleFlushTimer = setInterval(() => this.flushCandles(), CANDLE_FLUSH_MS);
    this.depthSweepTimer = setInterval(() => this.sweepDepthLeases(), 15_000);
    await this.connectLoop();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.tokenRefreshTimer);
    clearInterval(this.flushTimer);
    clearInterval(this.candleFlushTimer);
    clearInterval(this.depthSweepTimer);
    clearTimeout(this.silenceTimer);
    clearInterval(this.heartbeatTimer);
    this.ws?.close();
  }

  // --- depth lease management --------------------------------------------
  // A client asks for depth on the symbols it is currently rendering. Leases
  // expire so an abandoned tab can't keep an expensive level-2 subscription
  // alive forever; the client renews while the panel stays mounted.
  requestDepth(symbols) {
    if (!Array.isArray(symbols)) return;
    const until = Date.now() + DEPTH_LEASE_MS;
    const fresh = [];
    for (const sym of symbols.slice(0, DEPTH_MAX_SYMBOLS)) {
      const tok = this.bySymbol.get(String(sym).toUpperCase());
      if (tok == null) continue;
      const key = String(tok);
      if (!this.depthLeases.has(key)) fresh.push(key);
      this.depthLeases.set(key, until);
    }
    if (fresh.length > 0) this.sendDepthSubs(fresh, true);
  }

  sweepDepthLeases() {
    const now = Date.now();
    const expired = [];
    for (const [tok, until] of this.depthLeases) {
      if (until <= now) { this.depthLeases.delete(tok); expired.push(tok); }
    }
    if (expired.length > 0) this.sendDepthSubs(expired, false);
  }

  sendDepthSubs(tokens, subscribe) {
    if (this.ws?.readyState !== 1 || tokens.length === 0) return;
    const scrips = tokens.map((t) => `nse_cm|${t}`).join("&");
    try {
      this.ws.send(JSON.stringify({
        type: subscribe ? "DEPTH_SUBS" : "DEPTH_UNSUBS",
        scrips,
        channelnum: DEPTH_CHANNEL,
      }));
      log(`${subscribe ? "depth subscribed" : "depth released"}: ${tokens.length} instrument(s)`);
    } catch (e) {
      log("depth subscription failed:", e?.message ?? e);
    }
  }


  flushTicks() {
    if (!this.channel || this.tickBuffer.size === 0) return;
    const entries = Array.from(this.tickBuffer.values());
    this.tickBuffer.clear();
    // Split oversized batches into ≤ BROADCAST_MAX_BATCH chunks so a single
    // giant message never trips Realtime's payload cap.
    for (let i = 0; i < entries.length; i += BROADCAST_MAX_BATCH) {
      const chunk = entries.slice(i, i + BROADCAST_MAX_BATCH);
      this.channel.send({
        type: "broadcast",
        event: "ticks",
        payload: { ticks: chunk, ts: Date.now() },
      })?.catch((e) => log("ticks broadcast failed:", e?.message ?? e));
    }
  }

  flushCandles() {
    if (this.minuteBars.size === 0) return;
    const nowIso = new Date().toISOString();
    const rows = Array.from(this.minuteBars.values()).map((b) => ({
      symbol: b.symbol,
      exchange: "NSE",
      timeframe: "1m",
      ts: new Date(b.minute * 60_000).toISOString(),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      // `volume` is ALWAYS per-bar. The snapshot's running day total goes to
      // `cum_volume` so a reader can recompute the delta instead of guessing.
      volume: Math.max(0, Math.round(b.volume || 0)),
      cum_volume: b.cumVolume != null ? Math.max(0, Math.round(b.cumVolume)) : null,

      source: "kotak_tick",
      fetched_at: nowIso,
    }));
    // Keep the current and just-completed minute hot; older minutes are already
    // persisted and can be dropped from memory.
    const currentMinute = Math.floor(Date.now() / 60_000);
    for (const [key, b] of this.minuteBars) {
      if (b.minute < currentMinute - 1) this.minuteBars.delete(key);
    }
    svc.from("market_intraday_prices")
      .upsert(rows, { onConflict: "symbol,exchange,timeframe,ts" })
      .then(() => {}, (e) => log("candle flush failed:", e?.message ?? e));
  }

  numField(msg, fields) {
    for (const f of fields) {
      const v = msg?.[f];
      const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  ingestMinuteBar(symbol, ltp, msg) {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${symbol}:${minute}`;
    const prev = this.minuteBars.get(key);
    const cumulative = this.numField(msg, ["volume", "vol_traded_today", "totalTradedVolume", "total_traded_volume", "v", "vol", "ttv"]);
    const lastQty = this.numField(msg, ["ltq", "last_traded_quantity", "lastQty", "last_quantity", "qty"]);
    let addVol = 0;
    if (cumulative != null && cumulative >= 0) {
      const prevCum = this.lastCumVolume.get(symbol);
      if (prevCum != null && cumulative >= prevCum) addVol = cumulative - prevCum;
      this.lastCumVolume.set(symbol, cumulative);
    } else if (lastQty != null && lastQty > 0) {
      addVol = lastQty;
    }
    if (!prev) {
      this.minuteBars.set(key, { symbol, minute, open: ltp, high: ltp, low: ltp, close: ltp, volume: addVol, cumVolume: cumulative });
      return;
    }
    prev.high = Math.max(prev.high, ltp);
    prev.low = Math.min(prev.low, ltp);
    prev.close = ltp;
    prev.volume += addVol;
    if (cumulative != null && cumulative >= 0) prev.cumVolume = cumulative;

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
    const { byToken, bySymbol } = await fetchTokenMap();
    this.byToken = byToken;
    this.bySymbol = bySymbol;

    if (byToken.size === 0) {
      log("universe is empty — run 'Sync universe' in Settings first. Subscribing with 0 symbols.");
    }

    if (!this.channel) {
      // Shared system-feed channel: every signed-in browser subscribes here,
      // not to `market-ticks-<theirOwnUserId>`. Previously we broadcast on
      // `market-ticks-${session.userId}` (the FEED-OWNER's uid), so only that
      // one account received push ticks and everyone else silently fell back
      // to REST — the "stocks lag but indices don't" bug. RLS on
      // realtime.messages (migration 20260728…) lets any authenticated user
      // read this topic; service_role (this relay) bypasses RLS to write.
      this.channel = svc.channel(`market-ticks-system`, { config: { private: true } });
      await this.channel.subscribe((status) => {
        log("broadcast channel:", status);
        // Handshake so the UI can flip the chip to "push · kotak" immediately,
        // without waiting for the first tick on a thin symbol.
        if (status === "SUBSCRIBED") {
          this.channel?.send({ type: "broadcast", event: "hello", payload: { relay: "kotak-ws", ts: Date.now() } })
            .catch((e) => log("hello broadcast failed:", e?.message ?? e));
        }
      });
      // Legacy `subscribe` broadcast from clients is now a no-op — the relay
      // is already SCRIP_SUBSed to the full NSE universe on connect, so
      // client-side symbol nomination has been redundant for a while. Kept
      // the listener so old tabs still get a hello reply.
      this.channel.on("broadcast", { event: "subscribe" }, () => {
        this.channel?.send({ type: "broadcast", event: "hello", payload: { relay: "kotak-ws", ts: Date.now() } })
          .catch(() => { /* channel closing */ });
      });
      // Depth (level-2) is opt-in and leased: the A2 ladder broadcasts the
      // symbol it is showing and renews while mounted. This replaces the
      // 1s REST poll of the market-depth edge function.
      this.channel.on("broadcast", { event: "depth_subscribe" }, (msg) => {
        this.requestDepth(msg?.payload?.symbols ?? []);
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
        // Re-arm any depth leases that survived the disconnect.
        const live = [...this.depthLeases.keys()];
        if (live.length > 0) this.sendDepthSubs(live, true);

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
    // Kotak Neo sometimes packs multiple ticks into a single frame as an
    // array. Previously we processed only object frames — array batches
    // were dropped wholesale, appearing as "lag" on active symbols.
    if (Array.isArray(msg)) {
      for (const m of msg) this.handleTick(m);
      return;
    }
    this.handleTick(msg);
  }

  // Kotak's depth frames use flat, indexed fields: bp/bp1..bp4 (bid price),
  // bq/bq1..bq4 (bid qty), bno1..bno5 (bid order count) and the sp/bs/sno
  // mirror on the ask side. Same shape the REST `depth` quote returns, so the
  // parser here matches kotakClient.ts's flat extractor.
  extractDepth(msg) {
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const side = (p, q, o) => {
      const out = [];
      for (let i = 0; i < 5; i += 1) {
        const sfx = i === 0 ? "" : String(i);
        const price = num(msg[`${p}${sfx}`]);
        const qty = num(msg[`${q}${sfx}`]);
        if (price <= 0 && qty <= 0) continue;
        out.push({ price, qty, orders: num(msg[`${o}${i + 1}`]) });
      }
      return out;
    };
    const bids = side("bp", "bq", "bno");
    const asks = side("sp", "bs", "sno");
    return bids.length > 0 || asks.length > 0 ? { bids, asks } : null;
  }

  handleTick(msg) {
    // Heartbeat/ack frames and anything without a token are not ticks.
    const tok = String(msg?.tk ?? "");
    if (!tok) return;
    const symbol = this.byToken.get(tok);
    if (!symbol) return;

    // Depth frames arrive on the same socket; ship them straight through
    // (a handful of leased instruments, no batching needed) and keep going —
    // the same frame usually carries an LTP too.
    if (this.depthLeases.has(tok)) {
      const book = this.extractDepth(msg);
      if (book) {
        this.channel?.send({
          type: "broadcast",
          event: "depth",
          payload: { symbol, exchange: "NSE", ...book, ltp: Number(msg.ltp) || null, ts: Date.now() },
        })?.catch(() => { /* channel closing */ });
      }
    }

    const ltp = Number(msg.ltp);
    if (!Number.isFinite(ltp) || ltp <= 0) return;
    this.ingestMinuteBar(symbol, ltp, msg);

    const rawPct = msg.nc != null ? Number(msg.nc) : msg.cng != null ? Number(msg.cng) : NaN;
    // Delta frames often omit change_pct — carry the last-known value forward
    // so the UI's % column doesn't flicker to "—" between full snapshots.
    let changePct;
    if (Number.isFinite(rawPct)) {
      changePct = rawPct;
      this.lastChangePct.set(tok, rawPct);
    } else {
      changePct = this.lastChangePct.get(tok) ?? null;
    }
    // Buffer the tick — flushTicks() ships batches on the 100ms interval.
    // Last write wins per symbol so a rapid-fire ticker doesn't drown out
    // slower-moving symbols within one flush window.
    const volume = this.numField(msg, ["volume", "vol_traded_today", "totalTradedVolume", "total_traded_volume", "v", "vol", "ttv"]);
    const day_open = this.numField(msg, ["open_price", "opn_pric", "open", "o"]);
    const day_high = this.numField(msg, ["high_price", "hgh_pric", "high", "h"]);
    const day_low = this.numField(msg, ["low_price", "lw_pric", "low", "l"]);
    this.tickBuffer.set(symbol, { symbol, exchange: "NSE", ltp, change_pct: changePct, volume, day_open, day_high, day_low });
  }
}

const supervisor = new Supervisor();
process.on("SIGINT", () => { log("shutting down…"); supervisor.stop(); process.exit(0); });
process.on("SIGTERM", () => { log("shutting down…"); supervisor.stop(); process.exit(0); });

log("starting Kotak Neo live-tick relay");
await supervisor.start();
