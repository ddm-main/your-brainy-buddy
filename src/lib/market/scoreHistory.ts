// Score-history feedback loop — the evidence layer behind Breakout Intelligence.
//
// market_score_history holds one snapshot per symbol per session (score, band,
// bucket contributions, coverage) and, once enough sessions have elapsed, the
// realised forward 5/10/21-day returns for that snapshot. market_score_band_stats
// rolls those matured rows up per score band so the panel can state plainly how
// predictive the score has actually been, and market_scoring_calibration carries
// the fitted weight / r2 / sample_n per component.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const SCORE_MODEL = "breakout_v4";
// Below this many matured snapshots a band's hit rate is noise, not evidence.
export const MIN_BAND_SAMPLE = 200;

const num = (v: unknown): number | null =>
  v == null || Number.isNaN(Number(v)) ? null : Number(v);

export interface ScoreHistoryRow {
  trade_date: string;
  score: number | null;
  rank_pct: number | null;
  band: string | null;
  close: number | null;
  buckets: Record<string, number> | null;
  coverage: Record<string, number> | null;
  fwd_ret_5d: number | null;
  fwd_ret_10d: number | null;
  fwd_ret_21d: number | null;
  evaluated_at: string | null;
}

export interface ScoreBandStat {
  band: string;
  sample_n: number;
  sample_5d: number;
  sample_10d: number;
  sample_21d: number;
  avg_ret_5d: number | null;
  avg_ret_10d: number | null;
  avg_ret_21d: number | null;
  hit_rate_5d: number | null;
  hit_rate_10d: number | null;
  hit_rate_21d: number | null;
  first_date: string | null;
  last_date: string | null;
}

export interface CalibrationRow {
  component: string;
  weight: number;
  r2: number | null;
  sample_n: number | null;
  computed_at: string;
}

/** Daily v4 score snapshots for one symbol, oldest → newest. */
export function useScoreHistory(symbol: string | null | undefined, exchange = "NSE", bars = 60) {
  return useQuery({
    queryKey: ["market", "score-history", symbol, exchange, bars],
    enabled: !!symbol,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ScoreHistoryRow[]> => {
      if (!symbol) return [];
      const { data, error } = await (supabase as any)
        .from("market_score_history")
        .select("trade_date,score,rank_pct,band,close,buckets,coverage,fwd_ret_5d,fwd_ret_10d,fwd_ret_21d,evaluated_at")
        .eq("symbol", symbol)
        .eq("exchange", exchange)
        .eq("model", SCORE_MODEL)
        .order("trade_date", { ascending: false })
        .limit(bars);
      if (error) throw error;
      return (data ?? [])
        .map((r: any): ScoreHistoryRow => ({
          trade_date: r.trade_date,
          score: num(r.score),
          rank_pct: num(r.rank_pct),
          band: r.band ?? null,
          close: num(r.close),
          buckets: (r.buckets ?? null) as Record<string, number> | null,
          coverage: (r.coverage ?? null) as Record<string, number> | null,
          fwd_ret_5d: num(r.fwd_ret_5d),
          fwd_ret_10d: num(r.fwd_ret_10d),
          fwd_ret_21d: num(r.fwd_ret_21d),
          evaluated_at: r.evaluated_at ?? null,
        }))
        .reverse();
    },
  });
}

/** Universe-wide hit rate / mean forward return per score band. */
export function useScoreBandStats() {
  return useQuery({
    queryKey: ["market", "score-band-stats", SCORE_MODEL],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<ScoreBandStat[]> => {
      const { data, error } = await (supabase as any)
        .from("market_score_band_stats")
        .select("*")
        .eq("model", SCORE_MODEL);
      if (error) throw error;
      return (data ?? []).map((r: any): ScoreBandStat => ({
        band: r.band,
        sample_n: Number(r.sample_n ?? 0),
        sample_5d: Number(r.sample_5d ?? 0),
        sample_10d: Number(r.sample_10d ?? 0),
        sample_21d: Number(r.sample_21d ?? 0),
        avg_ret_5d: num(r.avg_ret_5d),
        avg_ret_10d: num(r.avg_ret_10d),
        avg_ret_21d: num(r.avg_ret_21d),
        hit_rate_5d: num(r.hit_rate_5d),
        hit_rate_10d: num(r.hit_rate_10d),
        hit_rate_21d: num(r.hit_rate_21d),
        first_date: r.first_date ?? null,
        last_date: r.last_date ?? null,
      }));
    },
  });
}

/** Fitted calibration for the current model version. */
export function useScoreCalibration() {
  return useQuery({
    queryKey: ["market", "score-calibration", SCORE_MODEL],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<CalibrationRow[]> => {
      const { data, error } = await (supabase as any)
        .from("market_scoring_calibration")
        .select("component,weight,r2,sample_n,computed_at")
        .eq("model_version", SCORE_MODEL)
        .order("weight", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((r: any): CalibrationRow => ({
        component: r.component,
        weight: Number(r.weight),
        r2: num(r.r2),
        sample_n: r.sample_n == null ? null : Number(r.sample_n),
        computed_at: r.computed_at,
      }));
    },
  });
}

export const BAND_ORDER = ["STRONG", "MODERATE", "WATCH", "WEAK"];

export function sortBands<T extends { band: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ia = BAND_ORDER.indexOf((a.band ?? "").toUpperCase());
    const ib = BAND_ORDER.indexOf((b.band ?? "").toUpperCase());
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}