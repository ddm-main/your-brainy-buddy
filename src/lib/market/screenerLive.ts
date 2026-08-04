// Screener "Live mode" quote layer.
//
// The bug this exists to kill: the screener filtered on the settled EOD row
// (market_screener_rows.change_pct_raw) while the results table rendered a
// live quote in the same column — so a 5–10% "1D Return" screen could show
// rows sitting at −1.4% today, because the 5–10% was yesterday's move.
//
// One map, two consumers: the live filter pass (filterMatchesLive) and the
// table's Price / 1D Return / Volume cells both read the map this module
// builds, so the filtered value and the displayed value cannot drift apart.
//
// Quoting is bounded. A 1s full-universe poll would hammer the Kotak/Yahoo
// limits the app is already tight against, so live-mode candidates are capped
// and polled on a slow cadence; WS push ticks (free, already streaming) win
// over REST for any symbol the relay covers.
import { useEffect, useMemo } from "react";
import { useQuotesBatched } from "./hooks";
import { quoteKey } from "./pnl";
import { isFreshTick, useLiveTickStore, useTicksRevision } from "./liveTickStore";
import { subscribeSymbolsForTicks } from "./useRealtimeTicks";
import type { LiveQuoteValue } from "./screenerCatalog";

/** Max candidates we will live-quote in one screen. Beyond this the UI tells
 *  the user to narrow instead of silently returning a partial result set. */
export const LIVE_QUOTE_CAP = 1000;
/** Slow poll: correctness needs current values, not tick-by-tick precision. */
const LIVE_POLL_MS = 15_000;

export interface ScreenerLive {
  /** exchange:symbol → live values (REST quote, overridden by a fresh push tick). */
  byKey: Map<string, LiveQuoteValue>;
  /** Candidates actually submitted for quoting. */
  quoted: number;
  /** Candidates that existed before the cap was applied. */
  candidates: number;
  truncated: boolean;
  isFetching: boolean;
  anyFailed: boolean;
}

export interface LiveCandidate { symbol: string; exchange?: string | null }

/** Stable, capped key list for a candidate row set. */
export function liveCandidateKeys(rows: LiveCandidate[], cap = LIVE_QUOTE_CAP): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const r of rows) {
    const k = quoteKey(r.exchange ?? "NSE", r.symbol);
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
    if (keys.length >= cap) break;
  }
  return keys;
}

export function useScreenerLiveQuotes(
  candidates: LiveCandidate[],
  enabled: boolean,
  cap = LIVE_QUOTE_CAP,
): ScreenerLive {
  const allKeysJoined = useMemo(
    () => (enabled ? liveCandidateKeys(candidates, Number.MAX_SAFE_INTEGER).join(",") : ""),
    [candidates, enabled],
  );
  const keysJoined = useMemo(() => {
    if (!allKeysJoined) return "";
    return allKeysJoined.split(",").slice(0, cap).join(",");
  }, [allKeysJoined, cap]);
  const keys = useMemo(() => (keysJoined ? keysJoined.split(",") : []), [keysJoined]);
  const candidateCount = allKeysJoined ? allKeysJoined.split(",").length : 0;

  const { quotes, isFetching, anyFailed } = useQuotesBatched(keys, 200, {
    refetchIntervalMs: enabled ? LIVE_POLL_MS : false,
    staleTimeMs: LIVE_POLL_MS - 1_000,
  });

  // Push ticks: subscribe only the first relay-sized slice; the relay caps
  // subscriptions and REST already covers the rest.
  const pushSlice = useMemo(() => keys.slice(0, 100), [keysJoined]);
  useEffect(() => {
    if (enabled) subscribeSymbolsForTicks(pushSlice);
  }, [enabled, pushSlice]);
  const _rev = useTicksRevision();
  void _rev; // re-render on tick flush; read the fresh map below
  const pushTicks = useLiveTickStore.getState().ticks;

  const byKey = useMemo(() => {
    const m = new Map<string, LiveQuoteValue>();
    if (!enabled) return m;
    for (const q of quotes) {
      m.set(quoteKey(q.exchange, q.symbol), {
        ltp: q.ltp ?? null,
        change_pct: q.change_pct ?? null,
        volume: q.volume ?? null,
        provider: (q as any).provider ?? q.source ?? null,
      });
    }
    for (const [key, tick] of Object.entries(pushTicks)) {
      if (!isFreshTick(tick)) continue;
      const prev = m.get(key);
      m.set(key, {
        ltp: tick.ltp ?? prev?.ltp ?? null,
        change_pct: tick.change_pct ?? prev?.change_pct ?? null,
        // The relay pushes price only; keep the REST volume when we have it.
        volume: (tick as any).volume ?? prev?.volume ?? null,
        provider: "kotak",
      });
    }
    return m;
  }, [enabled, quotes, pushTicks]);

  return {
    byKey,
    quoted: keys.length,
    candidates: candidateCount,
    truncated: candidateCount > keys.length,
    isFetching,
    anyFailed,
  };
}
