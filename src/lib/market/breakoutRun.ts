// Breakout tracker data layer — reads the durable episode + snapshot tables
// written by market-pipeline-aggregates. Mirrors screenerRun.ts conventions
// (react-query, explicit projection, num() coercion). The Breakout page joins
// these episodes with the live screener rows (useScreenerData) so it can reuse
// the shared filter catalog + live-tick overlay.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type BreakoutStatus = "active" | "extended" | "cooled" | "failed" | "closed";
export const OPEN_STATUSES: BreakoutStatus[] = ["active", "extended", "cooled"];

export interface BreakoutEpisode {
  symbol: string;
  exchange: string;
  first_detected_date: string;
  entry_close: number | null;
  detected_score: number | null;
  peak_close: number | null;
  peak_return_pct: number | null;
  current_close: number | null;
  current_return_pct: number | null;
  days_tracked: number;
  last_score: number | null;
  followthrough_score: number | null;
  score_trend: number[];
  status: BreakoutStatus;
  below_threshold_days: number;
  sector: string | null;
  market_cap: number | null;
  last_evaluated_date: string | null;
  closed_at: string | null;
}

export interface BreakoutSnapshot {
  symbol: string;
  exchange: string;
  trade_date: string;
  breakout_score: number | null;
  close: number | null;
}

const num = (v: any): number | null => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

function mapEpisode(r: any): BreakoutEpisode {
  return {
    symbol: r.symbol,
    exchange: r.exchange,
    first_detected_date: r.first_detected_date,
    entry_close: num(r.entry_close),
    detected_score: num(r.detected_score),
    peak_close: num(r.peak_close),
    peak_return_pct: num(r.peak_return_pct),
    current_close: num(r.current_close),
    current_return_pct: num(r.current_return_pct),
    days_tracked: Number(r.days_tracked ?? 1),
    last_score: num(r.last_score),
    followthrough_score: num(r.followthrough_score),
    score_trend: Array.isArray(r.score_trend) ? r.score_trend.map(Number) : [],
    status: (r.status ?? "active") as BreakoutStatus,
    below_threshold_days: Number(r.below_threshold_days ?? 0),
    sector: r.sector ?? null,
    market_cap: num(r.market_cap),
    last_evaluated_date: r.last_evaluated_date ?? null,
    closed_at: r.closed_at ?? null,
  };
}

/**
 * Breakout episodes. Defaults to open episodes only (active/extended/cooled) —
 * the tracker's hot list. Pass includeClosed to also pull failed/closed history.
 */
export function useBreakoutTracker(includeClosed = false, enabled = true) {
  return useQuery({
    queryKey: ["market", "breakout-tracker", includeClosed],
    queryFn: async (): Promise<BreakoutEpisode[]> => {
      const rows: any[] = [];
      for (let from = 0; ; from += 1000) {
        let q = (supabase as any)
          .from("market_breakout_tracker")
          .select("*")
          .order("first_detected_date", { ascending: false })
          .order("followthrough_score", { ascending: false, nullsFirst: false })
          .range(from, from + 999);
        if (!includeClosed) q = q.in("status", OPEN_STATUSES);
        const { data, error } = await q;
        if (error) throw error;
        const chunk = data ?? [];
        rows.push(...chunk);
        if (chunk.length < 1000) break;
      }
      return rows.map(mapEpisode);
    },
    staleTime: 60_000,
    enabled,
  });
}

/** Per-symbol daily score history for the trend sparkline / detail view. */
export function useBreakoutHistory(symbol: string | null, exchange = "NSE") {
  return useQuery({
    queryKey: ["market", "breakout-history", symbol, exchange],
    queryFn: async (): Promise<BreakoutSnapshot[]> => {
      if (!symbol) return [];
      const { data, error } = await (supabase as any)
        .from("market_breakout_snapshots")
        .select("symbol,exchange,trade_date,breakout_score,close")
        .eq("symbol", symbol)
        .eq("exchange", exchange)
        .order("trade_date", { ascending: true })
        .limit(60);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        symbol: r.symbol,
        exchange: r.exchange,
        trade_date: r.trade_date,
        breakout_score: num(r.breakout_score),
        close: num(r.close),
      }));
    },
    staleTime: 60_000,
    enabled: !!symbol,
  });
}
