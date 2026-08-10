// Feed heartbeat — the honest liveness record behind the Feed Routing page.
//
// Before this, the UI judged "is the Live price feed up?" by the freshness of
// public.market_quotes, a table only a throttled offline sync ever wrote (and
// which is empty). So a perfectly healthy Kotak quote path rendered as DOWN.
//
// Every live serving path now stamps one row per feed with WHO actually
// answered and WHEN. Writes are throttled per isolate so the ~1s quote poll
// doesn't turn into a 1 Hz database write.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

// Steady-state liveness only needs minute granularity; the quote route is
// polled every few seconds by every open panel, so a tighter window turned
// telemetry into a continuous write stream.
const MIN_WRITE_INTERVAL_MS = 60_000;
const lastWrite = new Map<string, number>();

export type HeartbeatInput = {
  feedId: string;
  provider: string;
  ok: boolean;
  latencyMs?: number | null;
  detail?: string | null;
  symbols?: number | null;
  /**
   * The code path that served the request — "live", "cache", "quote",
   * "mixed". This used to be written into `provider`, so the UI could not
   * match it against the routing chain and painted healthy feeds FALLBACK.
   */
  path?: string | null;
};

/** One provider spelling everywhere — mirrors the client's canonicalProviderId. */
export function canonicalProvider(name: string): string {
  const n = (name || "").toLowerCase();
  if (n.includes("kotak")) return "kotak_neo";
  if (n.includes("yahoo")) return "yahoo";
  if (n.includes("alpha")) return "alpha_vantage";
  if (n.includes("fmp") || n.includes("modeling")) return "fmp";
  if (n.includes("nse")) return "nse";
  if (n.includes("bse")) return "bse";
  return n || "unknown";
}

/** Fire-and-forget: never let heartbeat bookkeeping fail or slow a data path. */
export function recordFeedHeartbeat(svc: SupabaseClient, hb: HeartbeatInput): void {
  try {
    const now = Date.now();
    const last = lastWrite.get(hb.feedId) ?? 0;
    // Always record a transition to failure immediately; throttle steady state.
    if (hb.ok && now - last < MIN_WRITE_INTERVAL_MS) return;
    lastWrite.set(hb.feedId, now);
    svc.from("market_feed_heartbeat").upsert({
      feed_id: hb.feedId,
      provider: canonicalProvider(hb.provider),
      path: hb.path ?? null,
      ok: hb.ok,
      latency_ms: hb.latencyMs ?? null,
      detail: hb.detail ?? null,
      symbols: hb.symbols ?? null,
      observed_at: new Date(now).toISOString(),
    }, { onConflict: "feed_id" }).then(() => {}, () => {});
  } catch { /* never throw from telemetry */ }
}

/**
 * Dominant provider of a multi-provider batch plus a human mix string, e.g.
 * { provider: "yahoo", mix: "Yahoo 4/5, Kotak 1/5" }. Indices are resolved
 * per symbol, and stamping the batch "mixed" made a healthy feed unmatchable.
 */
export function dominantProvider(sources: string[]): { provider: string; mix: string | null } {
  const counts = new Map<string, number>();
  for (const s of sources) {
    const c = canonicalProvider(s);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (counts.size === 0) return { provider: "unknown", mix: null };
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = sources.length;
  return {
    provider: ranked[0][0],
    mix: ranked.length > 1 ? ranked.map(([p, n]) => `${p} ${n}/${total}`).join(", ") : null,
  };
}
