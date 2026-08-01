// market-score-evaluate — nightly maintenance of the score-history loop.
//
// Three SQL routines, in order, because each depends on the previous one:
//  1. evaluate_score_history_forward() — fills fwd_ret_5d/10d/21d (split
//     adjusted, from close_adjusted) and fwd_rel_* vs NIFTY over the same
//     window for every snapshot whose forward bars have now printed.
//  2. fit_score_calibration()          — refits breakout_v4 weights on liquid,
//     full-context rows only, including per-bucket attribution.
//  3. refresh_score_distribution()     — rebuilds the daily percentile band
//     cut-offs the panel reads.
//
// Also purges the stale breakout_v2 percentile rows once, so nothing can
// misread them as v4 weights.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { yahooChartRetry } from "../_shared/market/yahooClient.ts";
import { isDailyGrain } from "../_shared/market/candleGuard.ts";

const MODEL = "breakout_v4";
const BENCH = "^NSEI";

// Every relative-return column (fwd_rel_*) is computed against ^NSEI bars in
// market_daily_prices. When the index series is shallower than the score
// history, those rows evaluate to NULL forever and the calibration fit — which
// regresses on fwd_rel_21d — silently trains on a fraction of the sample.
// Top the benchmark up before evaluating, never after.
async function ensureBenchmarkHistory(svc: ReturnType<typeof svcClient>) {
  const { data: oldest } = await svc.from("market_score_history")
    .select("trade_date").order("trade_date", { ascending: true }).limit(1).maybeSingle();
  const need = (oldest as { trade_date?: string } | null)?.trade_date;
  if (!need) return { skipped: "no_history" };

  const { data: have } = await svc.from("market_daily_prices")
    .select("trade_date").eq("symbol", BENCH).eq("exchange", "NSE")
    .order("trade_date", { ascending: true }).limit(1).maybeSingle();
  const first = (have as { trade_date?: string } | null)?.trade_date ?? null;
  if (first && first <= need) return { ok: true, first_bar: first, needed_from: need, fetched: 0 };

  const candles = await yahooChartRetry(BENCH, "5y", "1d", 2).catch(() => []);
  if (!candles.length || !isDailyGrain(candles)) {
    return { ok: false, reason: "benchmark_fetch_failed", needed_from: need, first_bar: first };
  }
  const rows = candles
    .filter((c) => c.close != null)
    .map((c) => ({
      symbol: BENCH, exchange: "NSE",
      trade_date: new Date(c.time * 1000).toISOString().slice(0, 10),
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0,
    }));
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await svc.from("market_daily_prices")
      .upsert(rows.slice(i, i + 200), { onConflict: "symbol,exchange,trade_date" });
    if (!error) written += Math.min(200, rows.length - i);
  }
  return { ok: true, needed_from: need, first_bar: first, fetched: written };
}

interface Body { model?: string; min_n?: number; purge_legacy?: boolean }

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    if (req.headers.get("x-cron-secret") != null) {
      const guard = await requireCronSecret(req);
      if (guard) return guard;
    } else {
      const auth = await requireUserId(req);
      if ("error" in auth) return auth.error;
    }

    const body: Body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const model = typeof body.model === "string" && body.model ? body.model : MODEL;
    const minN = Math.max(20, Math.min(Number(body.min_n ?? 200) || 200, 5000));

    const svc = svcClient();
    const steps: Record<string, unknown> = {};

    steps.benchmark = await ensureBenchmarkHistory(svc).catch((e) => ({
      ok: false, reason: e instanceof Error ? e.message : String(e),
    }));

    const { data: evaluated, error: evalErr } = await svc.rpc("evaluate_score_history_forward", {
      _limit: 200000,
    });
    if (evalErr) return errorResponse(req, `evaluate: ${evalErr.message}`, 500);
    steps.evaluated_rows = evaluated ?? 0;

    if (body.purge_legacy !== false) {
      const { error: purgeErr } = await svc.from("market_scoring_calibration")
        .delete().neq("model_version", model);
      if (purgeErr) return errorResponse(req, `purge: ${purgeErr.message}`, 500);
      steps.legacy_purged = true;
    }

    const { data: fitted, error: fitErr } = await svc.rpc("fit_score_calibration", {
      _model: model, _min_n: minN,
    });
    if (fitErr) return errorResponse(req, `calibrate: ${fitErr.message}`, 500);
    steps.calibration_rows = fitted ?? 0;

    const { data: dist, error: distErr } = await svc.rpc("refresh_score_distribution", {
      _model: model,
    });
    if (distErr) return errorResponse(req, `distribution: ${distErr.message}`, 500);
    steps.distribution_rows = dist ?? 0;

    // Percentile bands + day-relative ranks, now that the distribution row for
    // each session exists. Bands used to be fixed 70/55/40, which reported an
    // entire weak session as WEAK even for its strongest names.
    const { data: rankedRows, error: rankErr } = await svc.rpc("stamp_score_history_ranks", {
      _model: model,
    });
    if (rankErr) return errorResponse(req, `rank: ${rankErr.message}`, 500);
    steps.ranked_rows = rankedRows ?? 0;

    // Self-check: a broken loop must be visible as a broken loop, not as
    // "coverage:insufficient". Reports what the evidence layer actually holds.
    const selfCheck: Record<string, unknown> = {};
    {
      const countOf = async (build: (q: any) => any) => {
        const { count } = await build(svc.from("market_score_history")
          .select("id", { count: "exact", head: true }).eq("model", model));
        return count ?? 0;
      };
      selfCheck.rows = await countOf((q) => q);
      selfCheck.rows_with_raw_detail = await countOf((q) => q.not("raw_buckets", "is", null));
      selfCheck.matured_21d = await countOf((q) => q.not("fwd_rel_21d", "is", null));
      selfCheck.live_liquid = await countOf((q) =>
        q.eq("context_neutral", false).eq("is_liquid_tradable", true));
    }
    steps.self_check = selfCheck;

    // Report what the fit actually had to work with, so a calibration built on
    // 38 alphabetically-first symbols is visible instead of looking authoritative.
    const { data: coverage } = await svc.rpc("score_history_coverage", { _model: model });
    steps.coverage = coverage ?? null;

    return jsonResponse(req, { ok: true, model, min_n: minN, ...steps });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
