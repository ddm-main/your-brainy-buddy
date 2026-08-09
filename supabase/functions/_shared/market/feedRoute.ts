// Feed routing — the operator's Primary/Fallback choices, actually honoured.
//
// Before this module, `market_feed_prefs` was read only by resolver.ts's
// field-level chain. The live serving routes (quotes, indices, candles) picked
// a provider through getReadProvider() and never looked at the prefs at all,
// so the Feed Routing selectors were decoration. Every live route now resolves
// its provider order through here.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

/** Provider ids as the routing UI spells them. */
export type RouteProvider = "kotak" | "shoonya" | "yahoo" | "nse" | "fmp" | "alpha" | "computed";

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
    const { data } = await svc.from("market_feed_prefs")
      .select("feed_id, provider, fallback_provider").eq("scope", "system");
    for (const row of (data ?? []) as Array<{ feed_id: string; provider: string | null; fallback_provider: string | null }>) {
      const primary = clean(row.provider);
      const fallback = clean(row.fallback_provider);
      if (!primary && !fallback) continue;
      map[row.feed_id] = { primary, fallback };
    }
  } catch { /* routing is advisory — never block a data read */ }
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

/** Provider ids used by the broker/vendor implementations. */
export function toProviderName(p: RouteProvider): string {
  return p === "kotak" ? "kotak_neo" : p === "alpha" ? "alpha_vantage" : p;
}