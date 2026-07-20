import { create } from "zustand";

export interface LiveTick {
  ltp: number;
  change_pct: number | null;
  receivedAt: number; // epoch ms
}

interface LiveTickStore {
  ticks: Record<string, LiveTick>;
  connected: boolean;
  upsertTick: (key: string, tick: Omit<LiveTick, "receivedAt">) => void;
  setConnected: (v: boolean) => void;
}

// Keyed by "EXCHANGE:SYMBOL" (see quoteKey in src/lib/market/pnl.ts) — one
// shared store for every push tick the relay delivers over Realtime, so any
// component can read the latest price for a symbol without its own subscription.
export const useLiveTickStore = create<LiveTickStore>((set) => ({
  ticks: {},
  connected: false,
  upsertTick: (key, tick) =>
    set((s) => ({ ticks: { ...s.ticks, [key]: { ...tick, receivedAt: Date.now() } } })),
  setConnected: (v) => set({ connected: v }),
}));

export const TICK_FRESH_MS = 5_000;

export function isFreshTick(tick: LiveTick | undefined, freshMs = TICK_FRESH_MS): tick is LiveTick {
  return !!tick && Date.now() - tick.receivedAt < freshMs;
}

// Overlay fresh push ticks onto a REST-derived quote map (both keyed by
// "EXCHANGE:SYMBOL") — the shared merge used by every list view (Holdings,
// Positions, Watchlist, Screener, Dashboard) so each only needs one
// `useLiveTickStore` subscription instead of a per-row hook.
export function mergeLiveQuotes<T extends { ltp: number; change_pct?: number | null }>(
  restByKey: Record<string, T>,
  ticks: Record<string, LiveTick>,
): Record<string, T> {
  const out: Record<string, T> = { ...restByKey };
  for (const [key, tick] of Object.entries(ticks)) {
    if (!isFreshTick(tick)) continue;
    const base = out[key];
    out[key] = base
      ? { ...base, ltp: tick.ltp, change_pct: tick.change_pct }
      : ({ ltp: tick.ltp, change_pct: tick.change_pct } as T);
  }
  return out;
}
