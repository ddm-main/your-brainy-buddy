// market-score-optimize — the Calibration Lab engine.
//
// Replays stored v4 snapshots (market_score_history: score, per-bucket points,
// per-bucket coverage, realised forward returns) and asks the only question
// that matters: would a different set of bucket weights have picked better
// stocks than the live weights did?
//
// How a stored snapshot is re-weighted without re-running the whole scorer:
//   v4 renormalises weights over the buckets that had data, so the points a
//   bucket contributed are  raw01 * W_b * (100 / sum(W of present buckets)).
//   Inverting that gives back raw01 per bucket, and any candidate weight
//   vector can then be applied to the same raw values. Exact, no re-scoring.
//
// Nothing here mutates the live model. It writes an optimizer run
// (market_score_optimizer_runs) that the UI reads; promoting a candidate is a
// separate, deliberate step.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { V4_WEIGHTS } from "../_shared/market/scoring.ts";

const BUCKETS = Object.keys(V4_WEIGHTS) as (keyof typeof V4_WEIGHTS)[];
const BASE: Record<string, number> = { ...V4_WEIGHTS };
// A bucket counts as "present" when the scorer had enough sub-factors for it.
const MIN_COVERAGE = 0.35;

interface Row {
  symbol: string;
  trade_date: string;
  score: number;
  raw: Record<string, number>;   // 0..1 per present bucket
  present: string[];
  // Everything the live scorer did AFTER the weighted bucket sum (penalties,
  // regime and fundamental multipliers, clamping), captured as the difference
  // between the stored final score and the stored bucket sum. Re-weighting
  // without it compares pre-penalty candidates against a post-penalty
  // threshold, so the cohort metrics describe a model that does not exist.
  adjust: number;
  ret: number | null;            // absolute forward return, chosen horizon
  rel: number | null;            // benchmark-relative forward return
}

interface Metrics {
  sample_n: number;
  corr: number;          // pearson(score, rel)
  top_decile_rel: number;
  bottom_decile_rel: number;
  spread: number;        // top - bottom (the number to maximise)
  cohort_n: number;      // rows scoring >= threshold
  cohort_rel: number;
  cohort_ret: number;
  cohort_hit: number;    // % of cohort with positive absolute return
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Score one stored snapshot under a candidate weight vector. */
function rescore(row: Row, w: Record<string, number>): number {
  let presentW = 0;
  for (const b of row.present) presentW += w[b] ?? 0;
  if (presentW <= 0) return 0;
  let pts = 0;
  for (const b of row.present) pts += (row.raw[b] ?? 0) * (w[b] ?? 0) * (100 / presentW);
  return Math.max(0, Math.min(100, pts + row.adjust));
}

function evaluate(rows: Row[], w: Record<string, number>, threshold: number): Metrics {
  const scored = rows.map((r) => ({ s: rescore(r, w), rel: r.rel, ret: r.ret }))
    .filter((x) => x.rel != null) as { s: number; rel: number; ret: number | null }[];
  if (scored.length < 20) {
    return { sample_n: scored.length, corr: 0, top_decile_rel: 0, bottom_decile_rel: 0, spread: 0, cohort_n: 0, cohort_rel: 0, cohort_ret: 0, cohort_hit: 0 };
  }
  const sorted = [...scored].sort((a, b) => a.s - b.s);
  const k = Math.max(5, Math.floor(sorted.length / 10));
  const bottom = sorted.slice(0, k).map((x) => x.rel);
  const top = sorted.slice(-k).map((x) => x.rel);
  const cohort = scored.filter((x) => x.s >= threshold);
  const cohortRet = cohort.map((x) => x.ret).filter((v): v is number => v != null);
  return {
    sample_n: scored.length,
    corr: r2(pearson(scored.map((x) => x.s), scored.map((x) => x.rel)) * 100) / 100,
    top_decile_rel: r2(mean(top)),
    bottom_decile_rel: r2(mean(bottom)),
    spread: r2(mean(top) - mean(bottom)),
    cohort_n: cohort.length,
    cohort_rel: r2(mean(cohort.map((x) => x.rel))),
    cohort_ret: r2(mean(cohortRet)),
    cohort_hit: cohortRet.length ? r2(100 * cohortRet.filter((v) => v > 0).length / cohortRet.length) : 0,
  };
}

function normalise(w: Record<string, number>): Record<string, number> {
  const sum = BUCKETS.reduce((s, b) => s + Math.max(0, w[b] ?? 0), 0) || 1;
  const out: Record<string, number> = {};
  for (const b of BUCKETS) out[b] = Math.round((Math.max(0, w[b] ?? 0) / sum) * 1000) / 10;
  return out;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return auth.error;

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const model: string = typeof body.model === "string" && body.model ? body.model : "breakout_v4";
    const days = Math.max(5, Math.min(Number(body.days ?? 90) || 90, 400));
    const threshold = Math.max(10, Math.min(Number(body.threshold ?? 70) || 70, 95));
    const horizon: "5d" | "10d" | "21d" = ["5d", "10d", "21d"].includes(body.horizon) ? body.horizon : "21d";
    const iterations = Math.max(20, Math.min(Number(body.iterations ?? 400) || 400, 2000));
    const persist = body.persist !== false;
    // Overlapping windows make every 21-day sample ~21x redundant, which
    // inflates the apparent sample size and lets the search fit noise. Keep
    // one session out of every `horizonDays` unless explicitly disabled.
    const horizonDays = horizon === "5d" ? 5 : horizon === "10d" ? 10 : 21;
    const deoverlap = body.deoverlap !== false;
    // Hold out the most recent third of sessions: a weight vector is only
    // interesting if it also wins on data the search never saw.
    const testFraction = Math.max(0.1, Math.min(Number(body.test_fraction ?? 0.3) || 0.3, 0.5));

    const svc = svcClient();
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const retCol = `fwd_ret_${horizon}`;
    const relCol = `fwd_rel_${horizon}`;

    // Page through matured snapshots that carry bucket detail.
    const rows: Row[] = [];
    const PAGE = 1000;
    for (let from = 0; from < 60_000; from += PAGE) {
      const { data, error } = await svc.from("market_score_history")
        .select(`symbol,trade_date,score,buckets,coverage,raw_buckets,is_liquid_tradable,context_neutral,${retCol},${relCol}`)
        .eq("model", model)
        .gte("trade_date", since)
        .not(relCol, "is", null)
        .not("buckets", "is", null)
        .order("trade_date", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) return errorResponse(req, error.message, 500);
      if (!data?.length) break;
      for (const d of data as Record<string, unknown>[]) {
        if (d.context_neutral === true) continue;
        if (d.is_liquid_tradable === false) continue;
        const buckets = (d.buckets ?? {}) as Record<string, number>;
        const coverage = (d.coverage ?? {}) as Record<string, number>;
        const present: string[] = [];
        for (const b of BUCKETS) {
          const cov = Number(coverage[b] ?? 0);
          if (cov >= MIN_COVERAGE) present.push(b);
        }
        if (present.length < 3) continue;
        const presentW = present.reduce((s, b) => s + BASE[b], 0);
        if (presentW <= 0) continue;
        const raw: Record<string, number> = {};
        const stored = (d.raw_buckets ?? null) as { raw?: Record<string, number> } | null;
        for (const b of present) {
          if (stored?.raw && stored.raw[b] != null) { raw[b] = Number(stored.raw[b]); continue; }
          const eff = BASE[b] * (100 / presentW);
          raw[b] = eff > 0 ? Math.max(0, Math.min(1, Number(buckets[b] ?? 0) / eff)) : 0;
        }
        // Bucket sum under the LIVE weights vs the score actually stored: the
        // gap is the penalty/multiplier effect for this row.
        let liveSum = 0;
        for (const b of present) liveSum += raw[b] * BASE[b] * (100 / presentW);
        const adjust = Number(d.score ?? 0) - liveSum;
        rows.push({
          symbol: String(d.symbol),
          trade_date: String(d.trade_date),
          score: Number(d.score ?? 0),
          raw, present,
          adjust: Number.isFinite(adjust) ? adjust : 0,
          ret: d[retCol] == null ? null : Number(d[retCol]),
          rel: d[relCol] == null ? null : Number(d[relCol]),
        });
      }
      if (data.length < PAGE) break;
    }

    // Thin the overlap, then split train / test by date.
    const allDates = Array.from(new Set(rows.map((r) => r.trade_date))).sort();
    const keepDates = deoverlap
      ? new Set(allDates.filter((_, i) => i % horizonDays === 0))
      : new Set(allDates);
    const usable = rows.filter((r) => keepDates.has(r.trade_date));
    const usedDates = Array.from(keepDates).sort();
    const cut = usedDates[Math.max(0, Math.floor(usedDates.length * (1 - testFraction)) - 1)] ?? "";
    const trainRows = usable.filter((r) => r.trade_date <= cut);
    const testRows = usable.filter((r) => r.trade_date > cut);
    // Too few sessions to hold anything out — fall back to in-sample only and
    // say so, rather than reporting a meaningless test score.
    const splitOk = trainRows.length >= 100 && testRows.length >= 50;
    const fitRows = splitOk ? trainRows : usable;

    if (usable.length < 100) {
      return jsonResponse(req, {
        ok: false,
        reason: "not_enough_history",
        message: `only ${usable.length} non-overlapping matured snapshots with bucket detail in the last ${days} days — need 100+. Run market-score-backfill and market-score-evaluate first.`,
        sample_n: usable.length,
        raw_rows: rows.length,
      });
    }

    const baseline = evaluate(fitRows, BASE, threshold);
    const baselineTest = splitOk ? evaluate(testRows, BASE, threshold) : null;

    // Search: coordinate perturbation around the live weights, keeping the
    // vector normalised to 100 so scores stay on the same scale.
    const candidates: {
      weights: Record<string, number>; metrics: Metrics; label: string;
      test_metrics: Metrics | null;
    }[] = [];
    const seen = new Set<string>();
    const push = (w: Record<string, number>, label: string) => {
      const nw = normalise(w);
      const key = BUCKETS.map((b) => nw[b]).join("|");
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({
        weights: nw,
        metrics: evaluate(fitRows, nw, threshold),
        test_metrics: splitOk ? evaluate(testRows, nw, threshold) : null,
        label,
      });
    };

    // 1. Single-bucket tilts — readable, explains WHICH bucket carries signal.
    for (const b of BUCKETS) {
      for (const mult of [0, 0.5, 1.5, 2]) {
        const w = { ...BASE }; w[b] = BASE[b] * mult;
        push(w, `${b} ×${mult}`);
      }
    }
    // 2. Random dirichlet-ish search around the base, hill-climbing on spread.
    let best = { ...BASE };
    let bestSpread = baseline.spread;
    for (let i = 0; i < iterations; i++) {
      const temp = 1 - i / iterations;
      const w: Record<string, number> = {};
      for (const b of BUCKETS) w[b] = Math.max(0, best[b] * (1 + (Math.random() - 0.5) * 1.2 * temp));
      const nw = normalise(w);
      const m = evaluate(fitRows, nw, threshold);
      if (m.sample_n >= 100 && m.spread > bestSpread) { best = nw; bestSpread = m.spread; }
      if (i % 25 === 0) push(nw, `search #${i}`);
    }
    push(best, "hill-climb best");

    // Rank on out-of-sample spread when there is a hold-out; a candidate that
    // only wins in-sample is an overfit, not an improvement.
    candidates.sort((a, b) =>
      (b.test_metrics?.spread ?? b.metrics.spread) - (a.test_metrics?.spread ?? a.metrics.spread));
    const top = candidates.slice(0, 12);
    const winner = top[0] ?? null;

    let runId: string | null = null;
    if (persist) {
      const { data: ins } = await svc.from("market_score_optimizer_runs").insert({
        model,
        params: {
          days, threshold, horizon, iterations, since,
          deoverlap, test_fraction: testFraction, split_ok: splitOk, split_date: cut,
        },
        baseline: { weights: BASE, metrics: baseline, test_metrics: baselineTest },
        candidates: top,
        best: winner,
        sample_n: fitRows.length,
        created_by: auth.userId ?? null,
      }).select("id").maybeSingle();
      runId = (ins as { id?: string } | null)?.id ?? null;
    }

    return jsonResponse(req, {
      ok: true, run_id: runId, model,
      params: { days, threshold, horizon, iterations, deoverlap, test_fraction: testFraction },
      sample_n: fitRows.length,
      test_n: testRows.length,
      split_ok: splitOk,
      split_date: cut,
      symbols: new Set(usable.map((r) => r.symbol)).size,
      sessions: usedDates.length,
      baseline: { weights: BASE, metrics: baseline, test_metrics: baselineTest },
      candidates: top,
      best: winner,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
