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

/**
 * Live v4 bucket weights — imported from the very file the edge scorer uses,
 * not copied. A hand-maintained mirror silently drifted the moment the scorer
 * changed, which made every "vs live" delta in the weight bars a lie.
 */
export { V4_WEIGHTS } from "../../../supabase/functions/_shared/market/v4Weights";



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

/**
 * Per-session count of names above `threshold`, and what happened next.
 *
 * `_population` is always sent explicitly. Two overloads of this function used
 * to exist (with and without the population argument) and every argument had a
 * default, so PostgREST could not choose between them and the call failed —
 * which is why the lab rendered as "no history yet" while the table held
 * thousands of rows.
 */
export function useScoreCohort(days = 30, threshold = 70, population: "fit" | "all" = "all") {
  return useQuery({
    queryKey: ["market", "score-cohort", days, threshold, population],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<CohortDay[]> => {
      const { data, error } = await (supabase as any).rpc("market_score_cohort", {
        _model: SCORE_MODEL, _days: days, _threshold: threshold, _population: population,
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
export function useScoreCohortSymbols(
  days = 30, threshold = 70, limit = 200, population: "fit" | "all" = "all",
) {
  return useQuery({
    queryKey: ["market", "score-cohort-symbols", days, threshold, limit, population],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<CohortSymbol[]> => {
      const { data, error } = await (supabase as any).rpc("market_score_cohort_symbols", {
        _model: SCORE_MODEL, _days: days, _threshold: threshold, _limit: limit,
        _population: population,
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
        // "*" on purpose: the run row carries the population / hold-out
        // provenance (population, live_rows, neutral_rows, split_ok, test_n),
        // and a hand-written column list silently dropped all of it, so the
        // "previous runs" list could not say which pool a run was fitted on.
        .select("*")

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

/**
 * How much *usable* evidence the lab actually has. The panels used to say
 * "no matured snapshots" without ever saying how far off maturity was, so an
 * empty lab and a broken lab looked identical.
 */
export interface LabCoverage {
  rows: number;
  matured21: number;
  maturedFit: number;
  liveRows: number;
  unknownLiquidity: number;
  /**
   * Rows the weight search can actually use, counted the way the optimizer
   * counts them: matured on the 21d relative horizon, carrying stored bucket
   * detail, and not explicitly illiquid — split by pool, because the optimizer
   * fits the live pool and only falls back to the replayed one.
   */
  optimizerLive: number;
  optimizerNeutral: number;
}

const countRows = async (
  build: (q: any) => any,
): Promise<number> => {
  let q = (supabase as any)
    .from("market_score_history")
    .select("id", { count: "exact", head: true })
    .eq("model", SCORE_MODEL);
  q = build(q);
  const { count, error } = await q;
  if (error) throw error;
  return Number(count ?? 0);
};

/** The optimizer's own row filter, minus the de-overlap thinning it applies. */
const optimizerPool = (q: any, neutral: boolean) =>
  q.not("fwd_rel_21d", "is", null)
    .not("buckets", "is", null)
    .not("is_liquid_tradable", "is", false)
    .eq("context_neutral", neutral);

export function useLabCoverage() {
  return useQuery({
    queryKey: ["market", "score-lab-coverage", SCORE_MODEL],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<LabCoverage> => {
      const [rows, matured21, maturedFit, liveRows, unknownLiquidity, optimizerLive, optimizerNeutral] =
        await Promise.all([
          countRows((q) => q),
          countRows((q) => q.not("fwd_rel_21d", "is", null)),
          countRows((q) => q.not("fwd_rel_21d", "is", null).eq("context_neutral", false).eq("is_liquid_tradable", true)),
          countRows((q) => q.eq("context_neutral", false)),
          countRows((q) => q.is("is_liquid_tradable", null)),
          countRows((q) => optimizerPool(q, false)),
          countRows((q) => optimizerPool(q, true)),
        ]);
      return {
        rows, matured21, maturedFit, liveRows, unknownLiquidity,
        optimizerLive, optimizerNeutral,
      };
    },
  });
}

/**
 * Minimum usable rows the weight search needs before it can say anything.
 * This is the optimizer's real floor (`usable.length < 100` in
 * market-score-optimize), not a softer UI number — the lab used to unblock the
 * button at 20 rows and then surface the engine's refusal as a result.
 */
export const MIN_OPTIMIZER_ROWS = 100;

/** The pool the search will actually fit on, and how far short it is. */
export function optimizerReadiness(coverage: LabCoverage | undefined) {
  if (!coverage) return null;
  const usesLive = coverage.optimizerLive >= MIN_OPTIMIZER_ROWS;
  const pool = usesLive ? coverage.optimizerLive : coverage.optimizerNeutral;
  return {
    population: usesLive ? ("full_context" as const) : ("replayed_neutral" as const),
    pool,
    shortfall: Math.max(0, MIN_OPTIMIZER_ROWS - pool),
    ready: pool >= MIN_OPTIMIZER_ROWS,
  };
}

/**
 * Mature + fit pass. Backfill only writes snapshots; this is the step that
 * fills forward returns, refits the calibration, refreshes the distribution
 * and stamps ranks. Without it in the UI, a fresh backfill stayed unmatured
 * and "not fitted yet" until the nightly cron happened to run.
 */
export function useRunEvaluate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("market-score-evaluate", {
        body: { model: SCORE_MODEL },
      });
      if (error) throw error;
      return data as {
        ok: boolean;
        evaluated_rows?: number;
        calibration_rows?: number;
        distribution_rows?: number;
        ranked_rows?: number;
        self_check?: Record<string, number>;
        coverage?: unknown;
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["market", "score-lab-coverage"] });
      qc.invalidateQueries({ queryKey: ["market", "score-cohort"] });
      qc.invalidateQueries({ queryKey: ["market", "score-band-stats"] });
      qc.invalidateQueries({ queryKey: ["market", "score-calibration"] });
    },
  });
}


/** Bounded backfill pass — replays scoring history for more symbols. */
export function useRunBackfill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { limit?: number; sessions?: number }) => {
      const { data, error } = await supabase.functions.invoke("market-score-backfill", {
        body: { limit: params.limit ?? 20, sessions: params.sessions ?? 120 },
      });
      if (error) throw error;
      return data as {
        ok: boolean; drained?: boolean; skipped?: string;
        symbols?: number; rows_written?: number;
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["market", "score-lab-coverage"] });
      qc.invalidateQueries({ queryKey: ["market", "score-cohort"] });
      qc.invalidateQueries({ queryKey: ["market", "score-band-stats"] });
    },
  });
}
