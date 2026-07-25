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
import { useLiveTickStore } from "./liveTickStore";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface TickPayload {
  symbol: string;
  exchange: string;
  ltp: number;
  change_pct: number | null;
}

// Shared channel handle so `subscribeSymbolsForTicks` (called from arbitrary
// components) can piggyback on the hook's subscription without opening
// another Realtime connection.
let sharedChannel: RealtimeChannel | null = null;

export const MAX_SUBSCRIBE_SYMBOLS = 100;
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


export function useRealtimeTicks() {
  const { session } = useSession();
  const setConnected = useLiveTickStore((s) => s.setConnected);
  const upsertTick = useLiveTickStore((s) => s.upsertTick);
  const setRelayAlive = useLiveTickStore((s) => s.setRelayAlive);
  const userId = session?.user.id;
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const channel = supabase.channel(`market-ticks-${userId}`, { config: { private: true } });
    channelRef.current = channel;
    sharedChannel = channel;
    channel
      .on("broadcast", { event: "tick" }, ({ payload }: { payload: TickPayload }) => {
        if (cancelled || !payload?.symbol || !Number.isFinite(payload.ltp)) return;
        // Any tick confirms the relay is actively pushing.
        setRelayAlive(true);
        upsertTick(`${(payload.exchange ?? "NSE").toUpperCase()}:${payload.symbol.toUpperCase()}`, {
          ltp: payload.ltp,
          change_pct: payload.change_pct ?? null,
        });
      })
      .on("broadcast", { event: "hello" }, () => {
        // Relay handshake — flips the chip to "push · kotak" before the first
        // tick actually lands, so thin symbols don't sit as "live · kotak".
        if (!cancelled) setRelayAlive(true);
      })
      .subscribe((status) => {
        if (!cancelled) setConnected(status === "SUBSCRIBED");
        // Flush any pending symbol set as soon as the channel is live.
        if (status === "SUBSCRIBED" && pendingSymbols) flushSubscribe();
      });

    return () => {
      cancelled = true;
      setConnected(false);
      setRelayAlive(false);
      if (sharedChannel === channel) sharedChannel = null;
      channelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [userId, setConnected, upsertTick, setRelayAlive]);
}

export function useRelayAlive(): boolean {
  return useLiveTickStore((s) => s.relayAlive);
}

// Freshness threshold (see liveTickStore.ts).
import { isFreshTick } from "./liveTickStore";

export interface PreferredTick {
  ltp: number;
  change_pct: number | null;
  live: boolean;
}

// Prefer a recently-pushed tick (relay running) over the REST-polled value;
// falls back to `rest` automatically once ticks stop arriving.
export function usePreferLiveTick(
  key: string | null | undefined,
  rest: { ltp: number; change_pct?: number | null } | null | undefined,
): PreferredTick | null {
  const tick = useLiveTickStore((s) => (key ? s.ticks[key] : undefined));
  if (isFreshTick(tick)) {
    return { ltp: tick.ltp, change_pct: tick.change_pct, live: true };
  }
  if (rest) return { ltp: rest.ltp, change_pct: rest.change_pct ?? null, live: false };
  return null;
}
