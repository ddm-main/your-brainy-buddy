// Calibration Lab data layer.
//
// Everything here reads the evidence tables written by the nightly loop:
//   market_score_history        one v4 snapshot per symbol per session
//   market_score_band_stats     band performance, per population
//   market_score_cohort()       who crossed a score threshold each session
//   market_score_optimizer_runs weight searches replayed over that history
//
// Nothing here changes the live model — promoting a candidate weight vector is
// a deliberate, separate action.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SCORE_MODEL } from "@/lib/market/scoreHistory";

/** Live v4 bucket weights — mirror of V4_WEIGHTS in the edge scorer. */
export const V4_WEIGHTS: Record<string, number> = {
  levels: 22,
  volume: 16,
  indicators: 16,
  setups: 13,
  strength: 13,
  patterns: 11,
  sentiment: 9,
};

const num = (v: unknown): number | null =>
  v == null || Number.isNaN(Number(v)) ? null : Number(v);

export interface CohortDay {
  trade_date: string;
  n_qualified: number;
  matured_5: number;
  matured_21: number;
  avg_ret_5d: number | null;
  avg_ret_10d: number | null;
  avg_ret_21d: number | null;
  avg_rel_21d: number | null;
  hit_rate_21d: number | null;
  avg_score: number | null;
}

export interface CohortSymbol {
  symbol: string;
  exchange: string;
  appearances: number;
  first_date: string;
  last_date: string;
  max_score: number;
  avg_score: number | null;
  first_ret_5d: number | null;
  first_ret_21d: number | null;
  first_rel_21d: number | null;
  best_ret_21d: number | null;
}

/** Per-session count of names above `threshold`, and what happened next. */
export function useScoreCohort(days = 30, threshold = 70) {
  return useQuery({
    queryKey: ["market", "score-cohort", days, threshold],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<CohortDay[]> => {
      const { data, error } = await (supabase as any).rpc("market_score_cohort", {
        _model: SCORE_MODEL, _days: days, _threshold: threshold,
      });
      if (error) throw error;
      return (data ?? []).map((r: any): CohortDay => ({
        trade_date: r.trade_date,
        n_qualified: Number(r.n_qualified ?? 0),
        matured_5: Number(r.matured_5 ?? 0),
        matured_21: Number(r.matured_21 ?? 0),
        avg_ret_5d: num(r.avg_ret_5d),
        avg_ret_10d: num(r.avg_ret_10d),
        avg_ret_21d: num(r.avg_ret_21d),
        avg_rel_21d: num(r.avg_rel_21d),
        hit_rate_21d: num(r.hit_rate_21d),
        avg_score: num(r.avg_score),
      }));
    },
  });
}

/** Membership + persistence: how many sessions each name held the threshold. */
export function useScoreCohortSymbols(days = 30, threshold = 70, limit = 200) {
  return useQuery({
    queryKey: ["market", "score-cohort-symbols", days, threshold, limit],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<CohortSymbol[]> => {
      const { data, error } = await (supabase as any).rpc("market_score_cohort_symbols", {
        _model: SCORE_MODEL, _days: days, _threshold: threshold, _limit: limit,
      });
      if (error) throw error;
      return (data ?? []).map((r: any): CohortSymbol => ({
        symbol: r.symbol,
        exchange: r.exchange,
        appearances: Number(r.appearances ?? 0),
        first_date: r.first_date,
        last_date: r.last_date,
        max_score: Number(r.max_score ?? 0),
        avg_score: num(r.avg_score),
        first_ret_5d: num(r.first_ret_5d),
        first_ret_21d: num(r.first_ret_21d),
        first_rel_21d: num(r.first_rel_21d),
        best_ret_21d: num(r.best_ret_21d),
      }));
    },
  });
}

export interface OptimizerMetrics {
  sample_n: number;
  corr: number;
  top_decile_rel: number;
  bottom_decile_rel: number;
  spread: number;
  cohort_n: number;
  cohort_rel: number;
  cohort_ret: number;
  cohort_hit: number;
}
export interface OptimizerCandidate {
  label: string;
  weights: Record<string, number>;
  metrics: OptimizerMetrics;
  /** Same weights scored on the held-out later sessions, when a split existed. */
  test_metrics?: OptimizerMetrics | null;
}
export interface OptimizerRun {
  id: string;
  model: string;
  params: { days?: number; threshold?: number; horizon?: string; iterations?: number; population?: string };
  baseline: { weights: Record<string, number>; metrics: OptimizerMetrics; test_metrics?: OptimizerMetrics | null } | null;
  candidates: OptimizerCandidate[];
  best: OptimizerCandidate | null;
  sample_n: number | null;
  symbols?: number | null;
  sessions?: number | null;
  /** Which pool the fit ran on: live full-context rows or replayed neutral ones. */
  population?: string | null;
  live_rows?: number | null;
  neutral_rows?: number | null;
  split_ok?: boolean;
  split_date?: string | null;
  test_n?: number | null;

  created_at: string;
}

export function useOptimizerRuns(limit = 10) {
  return useQuery({
    queryKey: ["market", "optimizer-runs", limit],
    staleTime: 60_000,
    queryFn: async (): Promise<OptimizerRun[]> => {
      const { data, error } = await (supabase as any)
        .from("market_score_optimizer_runs")
        .select("id,model,params,baseline,candidates,best,sample_n,created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as OptimizerRun[];
    },
  });
}

export interface OptimizeParams {
  days?: number;
  threshold?: number;
  horizon?: "5d" | "10d" | "21d";
  iterations?: number;
}

/** Kick off a weight search over the stored snapshots. */
export function useRunOptimizer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: OptimizeParams) => {
      const { data, error } = await supabase.functions.invoke("market-score-optimize", {
        body: { model: SCORE_MODEL, ...params },
      });
      if (error) throw error;
      return data as { ok: boolean; reason?: string; message?: string } & Partial<OptimizerRun> & {
        baseline?: OptimizerRun["baseline"]; candidates?: OptimizerCandidate[]; best?: OptimizerCandidate | null;
      };
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["market", "optimizer-runs"] }); },
  });
}
