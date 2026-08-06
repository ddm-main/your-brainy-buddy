// Live-plane status — the honest, plane-level answer to "how fresh is this
// screen?".
//
// Freshness is a property of the last *promoted* sweep, not of individual
// rows: a sweep either published atomically or it didn't. So there is one
// chip, fed by the newest `complete` run, instead of a per-row STALE badge
// that inverted its meaning every afternoon.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface LivePlaneStatus {
  sweep_id: string;
  session_date: string;
  as_of: string | null;
  completed_at: string | null;
  expected_count: number | null;
  priced_count: number | null;
  failed_count: number | null;
  kotak_count: number | null;
  yahoo_count: number | null;
  /** priced / expected, 0–100. */
  coverage_pct: number | null;
  /** Wall-clock seconds the sweep took, when both timestamps are present. */
  duration_s: number | null;
}

export function useLivePlaneStatus(enabled = true) {
  return useQuery({
    queryKey: ["market", "live-plane-status"],
    enabled,
    // The sweep runs every 5 minutes during the session; polling faster than
    // that only buys a stale-by-one-minute chip at extra egress.
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<LivePlaneStatus | null> => {
      const { data, error } = await (supabase as any)
        .from("market_live_price_runs")
        .select("sweep_id,session_date,as_of,started_at,completed_at,expected_count,priced_count,failed_count,kotak_count,yahoo_count")
        .eq("status", "complete")
        .order("as_of", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      const expected = data.expected_count == null ? null : Number(data.expected_count);
      const priced = data.priced_count == null ? null : Number(data.priced_count);
      const started = data.started_at ? Date.parse(data.started_at) : NaN;
      const done = data.completed_at ? Date.parse(data.completed_at) : NaN;
      return {
        sweep_id: data.sweep_id,
        session_date: data.session_date,
        as_of: data.as_of ?? null,
        completed_at: data.completed_at ?? null,
        expected_count: expected,
        priced_count: priced,
        failed_count: data.failed_count == null ? null : Number(data.failed_count),
        kotak_count: data.kotak_count == null ? null : Number(data.kotak_count),
        yahoo_count: data.yahoo_count == null ? null : Number(data.yahoo_count),
        coverage_pct: expected && expected > 0 && priced != null ? (priced / expected) * 100 : null,
        duration_s: Number.isFinite(started) && Number.isFinite(done) ? Math.round((done - started) / 1000) : null,
      };
    },
  });
}

/** Minutes since the promoted sweep's `as_of`, or null when unknown. */
export function planeAgeMinutes(s: LivePlaneStatus | null | undefined): number | null {
  if (!s?.as_of) return null;
  const t = Date.parse(s.as_of);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60_000));
}
