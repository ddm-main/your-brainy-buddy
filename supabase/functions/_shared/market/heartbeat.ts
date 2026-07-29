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

const MIN_WRITE_INTERVAL_MS = 20_000;
const lastWrite = new Map<string, number>();

export type HeartbeatInput = {
  feedId: string;
  provider: string;
  ok: boolean;
  latencyMs?: number | null;
  detail?: string | null;
  symbols?: number | null;
};

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
      provider: hb.provider,
      ok: hb.ok,
      latency_ms: hb.latencyMs ?? null,
      detail: hb.detail ?? null,
      symbols: hb.symbols ?? null,
      observed_at: new Date(now).toISOString(),
    }, { onConflict: "feed_id" }).then(() => {}, () => {});
  } catch { /* never throw from telemetry */ }
}
