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

const MODEL = "breakout_v4";

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

    return jsonResponse(req, { ok: true, model, min_n: minN, ...steps });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
