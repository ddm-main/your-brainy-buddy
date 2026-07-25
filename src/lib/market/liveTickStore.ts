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
  upsertTick: (key: string, tick: Omit<LiveTick, "receivedAt">) => void;
  setConnected: (v: boolean) => void;
  setRelayAlive: (v: boolean) => void;
}

// Keyed by "EXCHANGE:SYMBOL" (see quoteKey in src/lib/market/pnl.ts) — one
// shared store for every push tick the relay delivers over Realtime, so any
// component can read the latest price for a symbol without its own subscription.
export const useLiveTickStore = create<LiveTickStore>((set) => ({
  ticks: {},
  connected: false,
  relayAlive: false,
  upsertTick: (key, tick) =>
    set((s) => ({ ticks: { ...s.ticks, [key]: { ...tick, receivedAt: Date.now() } } })),
  setConnected: (v) => set({ connected: v }),
  setRelayAlive: (v) => set({ relayAlive: v }),
}));

// Freshness thresholds. Thin-volume stocks may only tick every ~30-60s from
// Kotak, so a 5s window was hiding real ticks. Off-hours we relax further so
// the last known tick still shows as "live" until we get a REST refresh.
export const TICK_FRESH_MS = 30_000;
export const TICK_FRESH_MS_OFF_HOURS = 5 * 60_000;

export function nseOpenNow(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday");
  if (day === "Sat" || day === "Sun") return false;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

export function isFreshTick(tick: LiveTick | undefined, freshMs?: number): tick is LiveTick {
  if (!tick) return false;
  const window = freshMs ?? (nseOpenNow() ? TICK_FRESH_MS : TICK_FRESH_MS_OFF_HOURS);
  return Date.now() - tick.receivedAt < window;
}

// Overlay fresh push ticks onto a REST-derived quote map (both keyed by
// "EXCHANGE:SYMBOL"). See original comment on invariant preservation.
export function mergeLiveQuotes<T extends { ltp: number; change_pct?: number | null }>(
  restByKey: Record<string, T>,
  ticks: Record<string, LiveTick>,
): Record<string, T> {
  const out: Record<string, T> = { ...restByKey };
  for (const [key, tick] of Object.entries(ticks)) {
    if (!isFreshTick(tick)) continue;
    const base = out[key];
    if (!base) continue;
    out[key] = { ...base, ltp: tick.ltp, change_pct: tick.change_pct };
  }
  return out;
}
