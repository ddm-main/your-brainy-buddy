// Background self-healing sync for the Market section.
// Runs quietly: only surfaces toasts on hard errors, never on success.
//
// Rules of thumb (inspired by how mainstream broker apps stay fresh):
//   • Fundamentals rarely change intra-day → check once/session, backfill if
//     any rows have `updated_at` older than 24h.
//   • Technical scores are day-based → refresh when `MAX(trade_date)` is not
//     today (IST) and the market has closed at least once since.
//   • Quotes / breadth are handled by existing polling in useQuotes/useIndices.
//
// The hook is mounted once from `src/routes/Market.tsx` and de-dupes via
// localStorage timestamps so tab switches don't storm the gateway.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const KEYS = {
  fund: "market:auto:fund:last",
  eod:  "market:auto:eod:last",
} as const;

const HOUR = 3_600_000;
const MIN_FUND_INTERVAL = 6 * HOUR;   // avoid re-hitting a slow queue
const MIN_EOD_INTERVAL  = 30 * 60_000;

async function fireQuiet(fn: string, chunked: boolean, onError: (msg: string) => void) {
  try {
    if (!chunked) {
      const { error } = await supabase.functions.invoke(fn, { body: {} });
      if (error) throw error;
      return;
    }
    // Drain chunked pipelines silently, cap at 15 invocations per background pass.
    for (let i = 0; i < 15; i++) {
      const { data, error } = await supabase.functions.invoke(fn, { body: {} });
      if (error) throw error;
      const d = (data ?? {}) as { drained?: boolean };
      if (d.drained) break;
    }
  } catch (e) {
    onError((e as Error).message || String(e));
  }
}

async function needsFundamentalsRefresh(): Promise<boolean> {
  const { data, error } = await supabase
    .from("market_fundamentals_global")
    .select("updated_at")
    .order("updated_at", { ascending: true, nullsFirst: true })
    .limit(1)
    .maybeSingle();
  if (error) return false;
  if (!data?.updated_at) return true;
  return Date.now() - new Date(data.updated_at).getTime() > 24 * HOUR;
}

async function needsScoresRefresh(): Promise<boolean> {
  const { data } = await supabase
    .from("market_stock_scores")
    .select("trade_date")
    .order("trade_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.trade_date) return true;
  // If newest score row is older than today (server date), refresh.
  const today = new Date().toISOString().slice(0, 10);
  return String(data.trade_date) < today;
}

export function useMarketAutoSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    const notifiedRef = { current: false };

    const run = async () => {
      // Fundamentals pass.
      const lastFund = Number(localStorage.getItem(KEYS.fund) || 0);
      if (Date.now() - lastFund > MIN_FUND_INTERVAL && await needsFundamentalsRefresh()) {
        localStorage.setItem(KEYS.fund, String(Date.now()));
        await fireQuiet("market-fundamentals-global-sync", true, (msg) => {
          if (!notifiedRef.current) {
            notifiedRef.current = true;
            console.warn("[market auto-sync] fundamentals:", msg);
          }
        });
        if (!cancelled) qc.invalidateQueries({ queryKey: ["market", "screener-rows-v3"] });
      }

      // Scores / EOD pass.
      const lastEod = Number(localStorage.getItem(KEYS.eod) || 0);
      if (Date.now() - lastEod > MIN_EOD_INTERVAL && await needsScoresRefresh()) {
        localStorage.setItem(KEYS.eod, String(Date.now()));
        await fireQuiet("market-pipeline-eod", true, (msg) => {
          if (!notifiedRef.current) {
            notifiedRef.current = true;
            console.warn("[market auto-sync] eod:", msg);
          }
        });
        await fireQuiet("market-pipeline-aggregates", false, (msg) => {
          console.warn("[market auto-sync] aggregates:", msg);
        });
        if (!cancelled) qc.invalidateQueries({ queryKey: ["market"] });
      }
    };

    // Kick once shortly after mount, then every 15 minutes while the tab lives.
    const t = setTimeout(() => { void run(); }, 2_000);
    const iv = setInterval(() => { void run(); }, 15 * 60_000);
    return () => { cancelled = true; clearTimeout(t); clearInterval(iv); };
  }, [qc]);
}
