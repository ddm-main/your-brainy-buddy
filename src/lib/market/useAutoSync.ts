// Background self-healing sync for the Market section.
// Runs quietly: only surfaces toasts on hard errors, never on success.
//
// Simplified from a multi-step chain to a single call into
// `market-daily-sync` (the same orchestrator pg_cron fires at 09:00 IST). The
// hook only fires when today has no `daily_sync_orchestrator/summary` row in
// `market_ingestion_runs` — i.e. the daily run hasn't landed yet — so tabbing
// through the app after 09:00 doesn't re-storm the gateway.
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const KEY_LAST = "market:auto:daily-sync:last";
const MIN_INTERVAL_MS = 6 * 3_600_000; // hard floor between attempts per tab

function todayIstDateString(): string {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  return ist.toISOString().slice(0, 10);
}

async function needsDailySync(): Promise<boolean> {
  const today = todayIstDateString();
  const { data } = await supabase
    .from("market_ingestion_runs")
    .select("finished_at,status")
    .eq("source", "daily_sync_orchestrator")
    .eq("stage", "summary")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.finished_at) return true;
  const finishedIst = new Date(new Date(data.finished_at).getTime() + 5.5 * 3600_000)
    .toISOString().slice(0, 10);
  return finishedIst < today;
}

export function useMarketAutoSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const last = Number(localStorage.getItem(KEY_LAST) || 0);
      if (Date.now() - last < MIN_INTERVAL_MS) return;
      try {
        if (!(await needsDailySync())) return;
        localStorage.setItem(KEY_LAST, String(Date.now()));
        const { error } = await supabase.functions.invoke("market-daily-sync", { body: {} });
        if (error) throw error;
        if (!cancelled) qc.invalidateQueries({ queryKey: ["market"] });
      } catch (e) {
        console.warn("[market auto-sync] daily-sync:", (e as Error).message || String(e));
      }
    };

    const t = setTimeout(() => { void run(); }, 3_000);
    const iv = setInterval(() => { void run(); }, 30 * 60_000);
    return () => { cancelled = true; clearTimeout(t); clearInterval(iv); };
  }, [qc]);
}

/** Fire a sync on mount, throttled per tab session.
 *  Used by Positions / Portfolio so a freshly opened page reflects the broker
 *  without the user having to hunt for the sync button. Only successful runs
 *  stamp the throttle key, so a transient failure retries on the next visit. */
export function useMountSync(enabled: boolean, key: string, minMs: number, run: () => Promise<unknown>): void {
  const ran = useRef(false);
  useEffect(() => {
    if (!enabled || ran.current) return;
    const last = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - last < minMs) return;
    ran.current = true;
    run().then(
      () => sessionStorage.setItem(key, String(Date.now())),
      () => { ran.current = false; },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, minMs]);
}
