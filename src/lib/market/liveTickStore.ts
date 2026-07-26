import { create } from "zustand";

export interface LiveTick {
  ltp: number;
  change_pct: number | null;
  receivedAt: number; // epoch ms
}

interface LiveTickStore {
  ticks: Record<string, LiveTick>;
  connected: boolean;
  // True once the Kotak WS relay has announced itself on the shared channel
  // (via a `hello` broadcast or any incoming tick). Used to distinguish
  // "push · kotak" (relay running, ticks flowing) from "live · kotak" (REST
  // only). Reset when the Realtime channel tears down.
  relayAlive: boolean;
  // epoch ms of the last hello/tick received. relayAlive was previously only
  // ever set true and never re-checked — if the relay process died or lost
  // its Kotak upstream after even one successful message, this flag (and
  // every "push · kotak" chip reading it) stayed green forever with zero
  // ticks actually flowing. useRealtimeTicks' watchdog compares this against
  // RELAY_STALE_MS to flip relayAlive back to false.
  lastRelayMessageAt: number | null;
  upsertTick: (key: string, tick: Omit<LiveTick, "receivedAt">) => void;
  setConnected: (v: boolean) => void;
  setRelayAlive: (v: boolean) => void;
  markRelayMessage: () => void;
}

// Keyed by "EXCHANGE:SYMBOL" (see quoteKey in src/lib/market/pnl.ts) — one
// shared store for every push tick the relay delivers over Realtime, so any
// component can read the latest price for a symbol without its own subscription.
export const useLiveTickStore = create<LiveTickStore>((set) => ({
  ticks: {},
  connected: false,
  relayAlive: false,
  lastRelayMessageAt: null,
  upsertTick: (key, tick) =>
    set((s) => ({ ticks: { ...s.ticks, [key]: { ...tick, receivedAt: Date.now() } } })),
  setConnected: (v) => set({ connected: v }),
  setRelayAlive: (v) => set({ relayAlive: v }),
  markRelayMessage: () => set({ relayAlive: true, lastRelayMessageAt: Date.now() }),
}));

// How long relayAlive is trusted without a fresh hello/tick before the
// watchdog in useRealtimeTicks flips it back to false.
export const RELAY_STALE_MS = 90_000;

// Freshness thresholds. Thin-volume stocks may only tick every ~30-60s from
// Kotak, so a 5s window was hiding real ticks. Off-hours we relax further so
// the last known tick still shows as "live" until we get a REST refresh.
export const TICK_FRESH_MS = 30_000;
export const TICK_FRESH_MS_OFF_HOURS = 5 * 60_000;

// Single source of truth for "is NSE in its regular cash session right
// now" — previously hooks.ts (marketOpen, raw UTC arithmetic),
// liveTickStore.ts (this function, Intl-based), and Dashboard.tsx
// (isNseOpen, a near-duplicate of this one) each had their own copy, free
// to silently drift out of sync. Plain UTC-minute arithmetic instead of
// Intl.DateTimeFormat — this runs inside react-query refetchInterval
// callbacks across many hooks/components, often many times a second, and
// constructing a formatter per call adds up; the IST trading window
// (03:45–10:00 UTC) never crosses a day boundary relative to IST, so
// getUTCDay() reliably matches the IST weekday for this specific check.
//
// Deliberately calendar-only, not holiday-aware — see the comment on
// isTradingHoliday() in supabase/functions/_shared/market/cron.ts for why
// that split is intentional: holiday-awareness matters where a wrong
// "market's open" call has a real consequence (alerts firing, AutoTrade
// placing an order on a holiday), which is already checked server-side.
// Worst case here is a few wasted polls on a holiday, not a wrong trade.
export function nseOpenNow(now = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMin >= 225 && utcMin <= 600; // IST 09:15–15:30
}

export function isFreshTick(tick: LiveTick | undefined, freshMs?: number): tick is LiveTick {
  if (!tick) return false;
  const window = freshMs ?? (nseOpenNow() ? TICK_FRESH_MS : TICK_FRESH_MS_OFF_HOURS);
  return Date.now() - tick.receivedAt < window;
}

// Overlay fresh push ticks onto a REST-derived quote map (both keyed by
// "EXCHANGE:SYMBOL"). See original comment on invariant preservation.
//
// restFetchedAt (react-query's `dataUpdatedAt` for the REST query) lets a
// tick be rejected when it's actually OLDER than the REST snapshot it would
// overlay — without it, "fresh" alone (any tick within TICK_FRESH_MS) always
// won even when REST had already returned a newer print, e.g. a thin-volume
// stock's last Kotak tick 25s old vs a REST refresh that landed 1s ago.
// Optional so existing callers that don't have it yet keep prior behavior.
export function mergeLiveQuotes<T extends { ltp: number; change_pct?: number | null }>(
  restByKey: Record<string, T>,
  ticks: Record<string, LiveTick>,
  restFetchedAt?: number,
): Record<string, T> {
  const out: Record<string, T> = { ...restByKey };
  for (const [key, tick] of Object.entries(ticks)) {
    if (!isFreshTick(tick)) continue;
    if (restFetchedAt != null && tick.receivedAt < restFetchedAt) continue;
    const base = out[key];
    if (!base) continue;
    out[key] = { ...base, ltp: tick.ltp, change_pct: tick.change_pct };
  }
  return out;
}
