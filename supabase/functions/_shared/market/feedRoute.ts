// Feed routing — the operator's Primary/Fallback choices, actually honoured.
//
// Before this module, `market_feed_prefs` was read only by resolver.ts's
// field-level chain. The live serving routes (quotes, indices, candles) picked
// a provider through getReadProvider() and never looked at the prefs at all,
// so the Feed Routing selectors were decoration. Every live route now resolves
// its provider order through here.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

/** Provider ids as the routing UI spells them. */
export type RouteProvider = "kotak" | "yahoo" | "nse" | "fmp" | "alpha" | "computed";

export type FeedRoute = { primary?: RouteProvider; fallback?: RouteProvider };

const TTL_MS = 30_000;
let cache: { at: number; map: Record<string, FeedRoute> } | null = null;

export function invalidateFeedRouteCache(): void {
  cache = null;
}

const clean = (v: string | null | undefined): RouteProvider | undefined =>
  v && v !== "auto" ? (v as RouteProvider) : undefined;

/** All app-wide (scope='system') routing rows, keyed by feed id. */
export async function getFeedRoutes(svc: SupabaseClient): Promise<Record<string, FeedRoute>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const map: Record<string, FeedRoute> = {};
  try {
    const { data, error } = await svc.from("market_feed_prefs")
      .select("feed_id, provider, fallback_provider").eq("scope", "system");
    // A swallowed read error is indistinguishable from "nothing pinned", so an
    // RLS/permission regression would silently disable routing forever. Log it.
    if (error) console.error("[feedRoute] prefs read failed:", error.message ?? error);
    for (const row of (data ?? []) as Array<{ feed_id: string; provider: string | null; fallback_provider: string | null }>) {
      const primary = clean(row.provider);
      const fallback = clean(row.fallback_provider);
      if (!primary && !fallback) continue;
      map[row.feed_id] = { primary, fallback };
    }
  } catch (e) {
    // routing is advisory — never block a data read, but never hide it either
    console.error("[feedRoute] prefs read threw:", e instanceof Error ? e.message : String(e));
  }
  cache = { at: Date.now(), map };
  return map;
}


export async function getFeedRoute(svc: SupabaseClient, feedId: string): Promise<FeedRoute> {
  const all = await getFeedRoutes(svc);
  return all[feedId] ?? {};
}

/**
 * primary → fallback → the rest of the built-in chain, de-duplicated. A pin
 * only *reorders*: a pinned-but-down provider degrades down the chain instead
 * of taking the feed dark.
 */
export function orderChain(base: RouteProvider[], route: FeedRoute | undefined): RouteProvider[] {
  const front = [route?.primary, route?.fallback].filter(Boolean) as RouteProvider[];
  const seen = new Set<RouteProvider>();
  return [...front, ...base].filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
}

/** Convenience: routed order for one feed. */
export async function resolveFeedRoute(
  svc: SupabaseClient,
  feedId: string,
  base: RouteProvider[],
): Promise<RouteProvider[]> {
  return orderChain(base, await getFeedRoute(svc, feedId));
}

/**
 * Built-in chain per routed feed — the same order the Feed Routing catalog
 * shows. A feed with no entry falls back to DEFAULT_CHAIN (broker, then the
 * public vendors).
 */
export const BASE_CHAIN: Record<string, RouteProvider[]> = {
  ltp: ["kotak", "yahoo"],
  // Kotak Neo carries no index instruments — indices are Yahoo-first by design.
  indices: ["yahoo", "kotak"],
  depth: ["kotak"],
  // Kotak publishes no candle API at all; history is Yahoo/NSE-served.
  candles_1d: ["yahoo", "nse"],
  candles_intraday: ["yahoo"],
  // No broker publishes P&L / ratios / ownership — vendor chain only.
  fundamentals: ["fmp", "yahoo"],
};

export const DEFAULT_CHAIN: RouteProvider[] = ["kotak", "yahoo"];

export const chainFor = (feedId?: string): RouteProvider[] =>
  (feedId && BASE_CHAIN[feedId]) || DEFAULT_CHAIN;

/**
 * Per-call latency budget. Without one, a fallback only ever happens on an
 * exception — a connected-but-crawling broker session was never demoted, so a
 * "slow feed" stayed slow forever. Exceeding the budget is a failure, which
 * lets the caller advance down the chain.
 */
export const LATENCY_BUDGET_MS: Record<string, number> = {
  ltp: 1_200,
  indices: 1_200,
  depth: 1_200,
  candles_1d: 3_000,
  candles_intraday: 3_000,
  funds: 4_000,
  fundamentals: 4_000,
};


export function withLatencyBudget<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} exceeded its ${ms}ms latency budget`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Provider ids used by the broker/vendor implementations. */
export function toProviderName(p: RouteProvider): string {
  return p === "kotak" ? "kotak_neo" : p === "alpha" ? "alpha_vantage" : p;
}