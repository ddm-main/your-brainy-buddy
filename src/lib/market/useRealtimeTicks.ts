// Bridges the local Kotak WS relay (Apps/relay/kotak-ws-relay.mjs) to the UI.
// The relay pushes ticks over a private Supabase Realtime broadcast channel
// scoped to the signed-in user; this hook opens ONE shared subscription (call
// it once, near the app root) and fans updates out via liveTickStore so every
// price-displaying component can prefer push data without its own channel.
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/useSession";
import { useLiveTickStore } from "./liveTickStore";

interface TickPayload {
  symbol: string;
  exchange: string;
  ltp: number;
  change_pct: number | null;
}

export function useRealtimeTicks() {
  const { session } = useSession();
  const setConnected = useLiveTickStore((s) => s.setConnected);
  const upsertTick = useLiveTickStore((s) => s.upsertTick);
  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const channel = supabase.channel(`market-ticks-${userId}`, { config: { private: true } });
    channel
      .on("broadcast", { event: "tick" }, ({ payload }: { payload: TickPayload }) => {
        if (cancelled || !payload?.symbol || !Number.isFinite(payload.ltp)) return;
        upsertTick(`${(payload.exchange ?? "NSE").toUpperCase()}:${payload.symbol.toUpperCase()}`, {
          ltp: payload.ltp,
          change_pct: payload.change_pct ?? null,
        });
      })
      .subscribe((status) => {
        if (!cancelled) setConnected(status === "SUBSCRIBED");
      });

    return () => {
      cancelled = true;
      setConnected(false);
      supabase.removeChannel(channel);
    };
  }, [userId, setConnected, upsertTick]);
}

const FRESH_MS = 5_000;

export interface PreferredTick {
  ltp: number;
  change_pct: number | null;
  live: boolean;
}

// Prefer a recently-pushed tick (relay running) over the REST-polled value;
// falls back to `rest` automatically once ticks stop arriving (relay not
// running, or this symbol isn't in the relay's subscribed universe). The
// freshness check is re-evaluated on every render — callers already re-render
// on their own ~1s REST poll, which is what actually notices staleness here.
export function usePreferLiveTick(
  key: string | null | undefined,
  rest: { ltp: number; change_pct?: number | null } | null | undefined,
): PreferredTick | null {
  const tick = useLiveTickStore((s) => (key ? s.ticks[key] : undefined));
  if (tick && Date.now() - tick.receivedAt < FRESH_MS) {
    return { ltp: tick.ltp, change_pct: tick.change_pct, live: true };
  }
  if (rest) return { ltp: rest.ltp, change_pct: rest.change_pct ?? null, live: false };
  return null;
}
