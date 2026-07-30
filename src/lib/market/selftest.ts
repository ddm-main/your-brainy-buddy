// Shared client access to the persisted provider/feed self-test.
// The heavy probing runs server-side (edge fn `market-selftest`, also on a
// pg_cron schedule); the app just reads the last stored result so status is
// instant on load and identical in the navbar chip, Providers and Feed Routing.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type SurfaceState = "ok" | "degraded" | "failed";
export type SurfaceProbe = {
  surface: string;
  provider: string;
  ok: boolean;
  state: SurfaceState;
  detail: string | null;
  latency_ms: number | null;
  checked_at: string;
  /** Did the feed's default primary answer, or a fallback? */
  is_primary_path?: boolean | null;
};

export const SELFTEST_QUERY_KEY = ["market", "surface-probes"] as const;
export const FRESHNESS_QUERY_KEY = ["market", "feed-freshness"] as const;
export const PROVIDER_STATS_KEY = ["market", "provider-stats-24h"] as const;

/** Latest stored probe per surface, best (most healthy, then newest) first. */
export function useSurfaceProbes() {
  return useQuery({
    queryKey: SELFTEST_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("market_surface_probes")
        .select("surface, provider, ok, state, detail, latency_ms, checked_at, is_primary_path")
        .order("checked_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SurfaceProbe[];
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
}

/**
 * Freshness of every table a feed lands in, in ONE call.
 * Previously each panel fired ~14 selects under the same query key but with
 * different result shapes, so whichever mounted first poisoned the other's
 * cache. One key, one shape, one round trip.
 */
export type Freshness = Record<string, string | null>;

export function useFeedFreshness() {
  return useQuery({
    queryKey: FRESHNESS_QUERY_KEY,
    queryFn: async (): Promise<Freshness> => {
      const { data, error } = await (supabase as any).rpc("market_feed_freshness");
      if (error) throw error;
      const out: Freshness = {};
      for (const r of (data ?? []) as { table_name: string; column_name: string; last_at: string | null }[]) {
        out[`${r.table_name}.${r.column_name}`] = r.last_at;
      }
      return out;
    },
    staleTime: 60_000,
    refetchInterval: 300_000,
  });
}

/** Canonical key for a freshness lookup — one spelling everywhere. */
export const freshKey = (table: { name: string; column: string } | undefined) =>
  table ? `${table.name}.${table.column}` : "";

const RANK: Record<SurfaceState, number> = { ok: 0, degraded: 1, failed: 2 };

/** Collapse multi-provider rows to one row per surface — the healthiest wins,
 *  because a feed served by its fallback is still a working feed. The primary's
 *  own row is kept alongside so callers can say *why* it is on a fallback. */
export type SurfaceHealth = SurfaceProbe & { primary?: SurfaceProbe; onFallback: boolean };

export function bestBySurface(rows: SurfaceProbe[]): Record<string, SurfaceHealth> {
  const best: Record<string, SurfaceProbe> = {};
  const primary: Record<string, SurfaceProbe> = {};
  for (const r of rows) {
    const cur = best[r.surface];
    if (!cur || RANK[r.state] < RANK[cur.state] || (RANK[r.state] === RANK[cur.state] && r.checked_at > cur.checked_at)) {
      best[r.surface] = r;
    }
    if (r.is_primary_path) {
      const p = primary[r.surface];
      if (!p || r.checked_at > p.checked_at) primary[r.surface] = r;
    }
  }
  const out: Record<string, SurfaceHealth> = {};
  for (const [surface, r] of Object.entries(best)) {
    const p = primary[surface];
    out[surface] = { ...r, primary: p, onFallback: !!p && !p.ok && r.ok };
  }
  return out;
}

export function summarize(rows: SurfaceProbe[]) {
  const best = Object.values(bestBySurface(rows));
  const down = best.filter((r) => r.state === "failed").length;
  // A feed that only survives because the fallback answered is not "healthy".
  const degraded = best.filter((r) => r.state === "degraded" || r.onFallback).length;
  const newest = rows.reduce<string | null>(
    (acc, r) => (!acc || r.checked_at > acc ? r.checked_at : acc), null);
  return { total: best.length, ok: best.length - down - degraded, down, degraded, checkedAt: newest };
}

/** 24h success rate + median latency per provider, from the health log. */
export type ProviderStats = { attempts: number; okRate: number; p50: number | null };

export function useProviderStats24h() {
  return useQuery({
    queryKey: PROVIDER_STATS_KEY,
    queryFn: async () => {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const { data, error } = await (supabase as any)
        .from("market_provider_health")
        .select("provider, ok, latency_ms")
        .gte("created_at", since)
        .limit(2000);
      if (error) throw error;
      const acc: Record<string, { ok: number; n: number; lat: number[] }> = {};
      for (const r of (data ?? []) as { provider: string; ok: boolean; latency_ms: number | null }[]) {
        const k = r.provider;
        acc[k] ??= { ok: 0, n: 0, lat: [] };
        acc[k].n += 1;
        if (r.ok) acc[k].ok += 1;
        if (r.latency_ms != null) acc[k].lat.push(r.latency_ms);
      }
      const out: Record<string, ProviderStats> = {};
      for (const [k, v] of Object.entries(acc)) {
        const sorted = v.lat.sort((a, b) => a - b);
        out[k] = {
          attempts: v.n,
          okRate: v.n ? Math.round((v.ok / v.n) * 100) : 0,
          p50: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        };
      }
      return out;
    },
    staleTime: 120_000,
    refetchInterval: 300_000,
  });
}

/** Run every provider + feed probe now. Invalidates all status queries. */
export function useRunSelfTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("market-selftest", { body: {} });
      if (error) throw error;
      return data as { down?: number; degraded?: number };
    },
    onSuccess: () => {
      for (const key of [
        SELFTEST_QUERY_KEY,
        FRESHNESS_QUERY_KEY,
        PROVIDER_STATS_KEY,
        ["market", "provider-health-latest"],
        ["market", "provider-credentials"],
        ["market", "feed-heartbeats"],
      ]) qc.invalidateQueries({ queryKey: key as unknown as string[] });
    },
  });
}

/** One provider id everywhere — probe rows carry both "kotak" and "kotak_neo". */
export function canonicalProviderId(name: string): string {
  const n = (name || "").toLowerCase();
  if (n.includes("kotak")) return "kotak_neo";
  if (n.includes("shoonya") || n.includes("noren") || n.includes("finvasia")) return "shoonya";
  if (n.includes("yahoo")) return "yahoo";
  if (n.includes("alpha")) return "alpha_vantage";
  if (n.includes("fmp") || n.includes("modeling")) return "fmp";
  if (n.includes("nse")) return "nse";
  if (n.includes("bse")) return "bse";
  return n || "unknown";
}
