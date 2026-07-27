import { create } from "zustand";

export interface LiveTick {
  ltp: number;
  change_pct: number | null;
  receivedAt: number; // epoch ms
}

interface LiveTickStore {
  ticks: Record<string, LiveTick>;
  // Monotonic counter bumped once per store write (applyTicks / upsertTick).
  // Consumers that need "something changed" subscribe to this cheap number
  // instead of the whole ticks map, so React equality-compares an integer
  // rather than a fresh object reference on every relay flush (~10 Hz).
  revision: number;
  connected: boolean;
  relayAlive: boolean;
  lastRelayMessageAt: number | null;
  upsertTick: (key: string, tick: Omit<LiveTick, "receivedAt">) => void;
  applyTicks: (batch: Array<{ symbol: string; exchange?: string; ltp: number; change_pct: number | null }>) => void;
  setConnected: (v: boolean) => void;
  setRelayAlive: (v: boolean) => void;
  markRelayMessage: () => void;
}

export const useLiveTickStore = create<LiveTickStore>((set) => ({
  ticks: {},
  revision: 0,
  connected: false,
  relayAlive: false,
  lastRelayMessageAt: null,
  upsertTick: (key, tick) =>
    set((s) => ({
      ticks: { ...s.ticks, [key]: { ...tick, receivedAt: Date.now() } },
      revision: s.revision + 1,
    })),
  applyTicks: (batch) => {
    if (!batch.length) return;
    const now = Date.now();
    set((s) => {
      const next = { ...s.ticks };
      let touched = 0;
      for (const t of batch) {
        if (!t?.symbol || !Number.isFinite(t.ltp)) continue;
        const key = `${(t.exchange ?? "NSE").toUpperCase()}:${t.symbol.toUpperCase()}`;
        next[key] = { ltp: t.ltp, change_pct: t.change_pct ?? null, receivedAt: now };
        touched++;
      }
      if (!touched) return s;
      return { ticks: next, revision: s.revision + 1 };
    });
  },
  setConnected: (v) => set({ connected: v }),
  setRelayAlive: (v) => set({ relayAlive: v }),
  markRelayMessage: () => set({ relayAlive: true, lastRelayMessageAt: Date.now() }),
}));

// Cheap subscription for parents that need to recompute on any tick flush but
// don't care about a specific key. Combine with useLiveTickStore.getState()
// inside a useMemo instead of subscribing to the full ticks record.
export function useTicksRevision(): number {
  return useLiveTickStore((s) => s.revision);
}

// Per-key selector — components that only need one symbol's tick can use
// this to avoid re-rendering on any other symbol's update. Existing
// `s.ticks` reads still work; new code should prefer this hook.
export function useTick(key: string | null | undefined): LiveTick | undefined {
  return useLiveTickStore((s) => (key ? s.ticks[key] : undefined));
}

// How long relayAlive is trusted without a fresh hello/tick before the
// watchdog in useRealtimeTicks flips it back to false. 30s (was 90s) so a
// dead relay stops falsely showing "push · kotak" for a minute and a half.
export const RELAY_STALE_MS = 30_000;

// Freshness thresholds. During hours the 1s REST poll is the fallback, so
// keep the "fresh push tick" window short — a thin symbol whose last push
// arrived 5s ago should defer to the newer REST value instead of pinning
// the row on a stale tick. Off-hours we relax further so the last known
// tick still shows as "live" until we get a REST refresh.
export const TICK_FRESH_MS = 5_000;
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
  // Iterate the (bounded) rest keys, not the full tick map — the relay may be
  // pushing hundreds of symbols site-wide while any single panel only cares
  // about the 20-200 it's currently rendering. Old code was O(ticks); this
  // is O(restByKey) which cuts per-flush merge cost by 10-100x on Screener.
  for (const key of Object.keys(restByKey)) {
    const tick = ticks[key];
    if (!isFreshTick(tick)) continue;
    if (restFetchedAt != null && tick.receivedAt < restFetchedAt) continue;
    out[key] = { ...out[key], ltp: tick.ltp, change_pct: tick.change_pct };
  }
  return out;
}
