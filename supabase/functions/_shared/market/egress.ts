// Egress rollup — sums what the app measured itself.
//
// Supabase's Management API no longer exposes a per-project egress figure
// (`/daily-stats` returns 404 and the organisation usage route is not readable
// with a project-scoped token), and free-plan edge logs are pruned after
// minutes. So the browser meters every Supabase response it receives
// (src/lib/egressMeter.ts) into `public.system_egress_daily`, and this rolls
// those rows up for the current billing cycle into `system_quota_state` for the
// quota panel and the maintenance governor.
//
// It lives in _shared (invoked through `market-selftest`) because this project
// has no free edge-function slots left.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type EgressSyncResult = {
  ok: boolean;
  error?: string;
  source?: string;
  egress_bytes?: number;
  breakdown?: Record<string, number>;
  window?: { start: string; end: string };
  governor?: unknown;
};

/** Start of the current Supabase billing cycle (defaults to the 23rd). */
function cycleStart(day: number, now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  if (now.getUTCDate() < day) d.setUTCMonth(d.getUTCMonth() - 1);
  return d;
}

export async function syncEgressUsage(svc: SupabaseClient): Promise<EgressSyncResult> {
  const { data: state, error: stateErr } = await svc
    .from("system_quota_state")
    .select("egress_cycle_day")
    .limit(1)
    .maybeSingle();
  if (stateErr) return { ok: false, error: stateErr.message };

  const day = Number((state as any)?.egress_cycle_day ?? 23) || 23;
  const start = cycleStart(day);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);

  // Page through the cycle's measured rows (one row per day/source/route).
  const breakdown: Record<string, number> = {};
  let total = 0;
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await svc
      .from("system_egress_daily")
      .select("source,bytes")
      .gte("day", startDate)
      .range(from, from + page - 1);
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as Array<{ source: string; bytes: number | string }>;
    for (const r of rows) {
      const b = Number(r.bytes) || 0;
      breakdown[r.source] = (breakdown[r.source] ?? 0) + b;
      total += b;
    }
    if (rows.length < page) break;
    from += page;
  }

  const { error: upErr } = await svc.from("system_quota_state").update({
    egress_bytes: Math.round(total),
    egress_breakdown: breakdown,
    egress_window_start: startDate,
    egress_window_end: endDate,
    egress_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", true);
  if (upErr) return { ok: false, error: upErr.message };

  const { data: gov } = await svc.rpc("apply_egress_governor");

  return {
    ok: true,
    source: "measured",
    egress_bytes: Math.round(total),
    breakdown,
    window: { start: startDate, end: endDate },
    governor: gov,
  };
}

/** True when the stored figure is older than `hours` (or never synced). */
export async function egressSyncStale(svc: SupabaseClient, hours = 6): Promise<boolean> {
  const { data } = await svc.from("system_quota_state").select("egress_synced_at").limit(1).maybeSingle();
  const at = (data as any)?.egress_synced_at as string | null | undefined;
  if (!at) return true;
  return Date.now() - new Date(at).getTime() > hours * 3_600_000;
}
