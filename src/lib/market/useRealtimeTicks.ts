// Bridges the local Kotak WS relay (Apps/relay/kotak-ws-relay.mjs) to the UI.
// The relay pushes ticks over a private Supabase Realtime broadcast channel
// scoped to the signed-in user; this hook opens ONE shared subscription (call
// it once, near the app root) and fans updates out via liveTickStore so every
// price-displaying component can prefer push data without its own channel.
//
// It also exposes `subscribeSymbolsForTicks(keys[])` — a debounced broadcast
// on the SAME channel that tells the relay which symbols the UI wants pushed.
// The relay diffs it against its Kotak WS subscription set so panels like
// "Top Breakouts" (whose symbols rotate with filters) actually get push ticks
// instead of falling back to the ~1s REST poll.
import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/useSession";
import { useLiveTickStore, RELAY_STALE_MS } from "./liveTickStore";
import { useLiveDepthStore, type DepthLevel } from "./liveDepthStore";

import type { RealtimeChannel } from "@supabase/supabase-js";

interface TickPayload {
  symbol: string;
  exchange: string;
  ltp: number;
  change_pct: number | null;
  volume?: number | null;
  day_open?: number | null;
  day_high?: number | null;
  day_low?: number | null;
}

// Shared channel handle so `subscribeSymbolsForTicks` (called from arbitrary
// components) can piggyback on the hook's subscription without opening
// another Realtime connection.
let sharedChannel: RealtimeChannel | null = null;

const MAX_SUBSCRIBE_SYMBOLS = 100;
let pendingSymbols: Set<string> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let truncationWarned = false;

function flushSubscribe() {
  flushTimer = null;
  if (!sharedChannel || !pendingSymbols) return;
  const all = Array.from(pendingSymbols);
  const symbols = all.slice(0, MAX_SUBSCRIBE_SYMBOLS);
  if (all.length > MAX_SUBSCRIBE_SYMBOLS && !truncationWarned) {
    truncationWarned = true;
    // Fire-and-forget: user sees they're at the cap so a missing tick
    // doesn't look like a bug. Guarded once per session to avoid spam.
    // eslint-disable-next-line no-console
    console.warn(`[market] Push-tick subscription capped at ${MAX_SUBSCRIBE_SYMBOLS}; ${all.length - MAX_SUBSCRIBE_SYMBOLS} symbol(s) will use REST polling instead.`);
  }
  pendingSymbols = null;
  sharedChannel.send({ type: "broadcast", event: "subscribe", payload: { symbols } })
    .catch(() => { /* relay may not be running — ignore */ });
}

// Public API: any panel showing rotating symbols (Top Breakouts, Screener
// preview, Watchlist) can call this to expand the relay's push coverage.
// Debounced 500ms — MERGES successive calls (previously the last call
// overwrote earlier symbol sets so two panels racing lost coverage).
export function subscribeSymbolsForTicks(keys: string[]): void {
  if (!keys.length) return;
  const upper = keys.map((k) => k.toUpperCase());
  if (pendingSymbols) upper.forEach((k) => pendingSymbols!.add(k));
  else pendingSymbols = new Set(upper);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushSubscribe, 500);
}

// Depth (level-2) is leased, not permanent: the relay drops the subscription
// if we stop renewing (see DEPTH_LEASE_MS there). Renew comfortably inside
// that window so a long-open Analysis tab keeps its ladder.
const DEPTH_RENEW_MS = 30_000;

/** Ask the relay to push the order book for `symbol` while the panel is mounted. */
export function useLiveDepthSubscription(symbol: string | null | undefined): void {
  useEffect(() => {
    if (!symbol) return;
    const sym = symbol.toUpperCase();
    const send = () => {
      sharedChannel?.send({ type: "broadcast", event: "depth_subscribe", payload: { symbols: [sym] } })
        .catch(() => { /* relay may not be running — REST fallback covers it */ });
    };
    send();
    const timer = setInterval(send, DEPTH_RENEW_MS);
    return () => clearInterval(timer);
  }, [symbol]);
}




export function useRealtimeTicks() {
  const { session } = useSession();
  const setConnected = useLiveTickStore((s) => s.setConnected);
  const upsertTick = useLiveTickStore((s) => s.upsertTick);
  const applyTicks = useLiveTickStore((s) => s.applyTicks);
  const setRelayAlive = useLiveTickStore((s) => s.setRelayAlive);
  const markRelayMessage = useLiveTickStore((s) => s.markRelayMessage);
  const userId = session?.user.id;
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    // Shared system-feed channel: the Kotak relay broadcasts here, and every
    // signed-in client listens. Previously the client channel was scoped to
    // `market-ticks-${session.user.id}` while the relay broadcast on the
    // FEED-OWNER's uid, so only that one account received push ticks and
    // everyone else fell back to REST (indices still felt fast because
    // they're on a 1s REST poll of their own; individual stocks lagged).
    const channel = supabase.channel(`market-ticks-system`, { config: { private: true } });
    channelRef.current = channel;
    sharedChannel = channel;
    channel
      .on("broadcast", { event: "ticks" }, ({ payload }: { payload: { ticks: Array<{ symbol: string; exchange?: string; ltp: number; change_pct: number | null; volume?: number | null; day_open?: number | null; day_high?: number | null; day_low?: number | null }> } }) => {
        // Batched path — the relay coalesces up to 100ms of ticks into one
        // message so we do a single store write per flush regardless of how
        // many symbols moved.
        if (cancelled || !Array.isArray(payload?.ticks) || payload.ticks.length === 0) return;
        markRelayMessage();
        applyTicks(payload.ticks);
      })
      .on("broadcast", { event: "tick" }, ({ payload }: { payload: TickPayload }) => {
        // Legacy single-tick path — kept so an older relay build still works
        // during a rolling deploy. New relays emit `ticks` batches.
        if (cancelled || !payload?.symbol || !Number.isFinite(payload.ltp)) return;
        markRelayMessage();
        upsertTick(`${(payload.exchange ?? "NSE").toUpperCase()}:${payload.symbol.toUpperCase()}`, {
          ltp: payload.ltp,
          change_pct: payload.change_pct ?? null,
          volume: payload.volume ?? null,
          day_open: payload.day_open ?? null,
          day_high: payload.day_high ?? null,
          day_low: payload.day_low ?? null,
        });
      })
      .on("broadcast", { event: "depth" }, ({ payload }: { payload: { symbol?: string; exchange?: string; bids?: DepthLevel[]; asks?: DepthLevel[]; ltp?: number | null } }) => {
        // Pushed order book for a leased symbol (A2 ladder). Replaces the
        // per-second REST poll of the market-depth edge function.
        if (cancelled || !payload?.symbol) return;
        markRelayMessage();
        useLiveDepthStore.getState().applyDepth(
          `${(payload.exchange ?? "NSE").toUpperCase()}:${payload.symbol.toUpperCase()}`,
          { bids: payload.bids ?? [], asks: payload.asks ?? [], ltp: payload.ltp ?? null },
        );
      })
      .on("broadcast", { event: "hello" }, () => {
        // Relay handshake — flips the chip to "push · kotak" before the first
        // tick actually lands, so thin symbols don't sit as "live · kotak".
        if (!cancelled) markRelayMessage();
      })

      .subscribe((status) => {
        if (!cancelled) setConnected(status === "SUBSCRIBED");
        // Flush any pending symbol set as soon as the channel is live.
        if (status === "SUBSCRIBED" && pendingSymbols) flushSubscribe();
      });

    // Watchdog: relayAlive is only ever set true by a hello/tick above. If
    // the relay process dies or loses its Kotak upstream after even one
    // message, nothing here would otherwise ever clear it. Poll every 5s
    // (was 15s) so the "push · kotak" chip flips promptly.
    const watchdog = setInterval(() => {
      const { lastRelayMessageAt, relayAlive } = useLiveTickStore.getState();
      if (relayAlive && lastRelayMessageAt != null && Date.now() - lastRelayMessageAt > RELAY_STALE_MS) {
        setRelayAlive(false);
      }
    }, 5_000);

    return () => {
      cancelled = true;
      clearInterval(watchdog);
      setConnected(false);
      setRelayAlive(false);
      if (sharedChannel === channel) sharedChannel = null;
      channelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [userId, setConnected, upsertTick, applyTicks, setRelayAlive, markRelayMessage]);
}

export function useRelayAlive(): boolean {
  return useLiveTickStore((s) => s.relayAlive);
}

// Freshness threshold (see liveTickStore.ts).
import { isFreshTick } from "./liveTickStore";

export interface PreferredTick {
  ltp: number;
  change_pct: number | null;
  volume?: number | null;
  day_open?: number | null;
  day_high?: number | null;
  day_low?: number | null;
  live: boolean;
}

// Prefer a recently-pushed tick (relay running) over the REST-polled value;
// falls back to `rest` automatically once ticks stop arriving.
export function usePreferLiveTick(
  key: string | null | undefined,
  rest: { ltp: number; change_pct?: number | null; volume?: number | null; day_open?: number | null; day_high?: number | null; day_low?: number | null } | null | undefined,
  restFetchedAt?: number,
): PreferredTick | null {
  const tick = useLiveTickStore((s) => (key ? s.ticks[key] : undefined));
  if (isFreshTick(tick) && (restFetchedAt == null || tick.receivedAt >= restFetchedAt)) {
    return {
      ltp: tick.ltp,
      change_pct: tick.change_pct,
      volume: tick.volume ?? null,
      day_open: tick.day_open ?? null,
      day_high: tick.day_high ?? null,
      day_low: tick.day_low ?? null,
      live: true,
    };
  }
  if (rest) {
    return {
      ltp: rest.ltp,
      change_pct: rest.change_pct ?? null,
      volume: rest.volume ?? null,
      day_open: rest.day_open ?? null,
      day_high: rest.day_high ?? null,
      day_low: rest.day_low ?? null,
      live: false,
    };
  }
  return null;
}
