// market-score-backfill — one-off replay of the v4 scorer over history.
//
// The score-history feedback loop only means something once there are matured
// snapshots to look back at: with 0 rows the panel honestly says "collecting"
// for the next three weeks and the calibration cannot be fitted at all. This
// worker replays breakoutScoreV4 session by session over the stored daily
// candles and writes one market_score_history row per symbol per session.
//
// Honest limits, deliberately encoded rather than papered over:
//  - Sector strength, RS-vs-NIFTY and the regime are point-in-time market
//    context that is NOT reconstructible from stored prices. Replayed rows get
//    a NEUTRAL context and are stamped `context_neutral = true` + a
//    `context: 0` coverage entry, and fit_score_calibration() excludes them.
//    Faking that context would flatter the r².
//  - Fundamentals / AI verdict / news sentiment are as-of-today, not as-of-
//    session, so they are left out entirely rather than leaked backwards.
//
// Resumable: each invocation claims a bounded batch of symbols that still have
// fewer than `min_rows` snapshots, and upserts on
// (symbol, exchange, trade_date, model).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import {
  computeSnapshot, computeWeeklySnapshot, type Candle,
} from "../_shared/market/indicators.ts";
import {
  vwap as vwapSeries, supertrend, mfi as mfiSeries, percentB, detectPatterns,
} from "../_shared/market/indicators-advanced.ts";
import {
  breakoutScoreV4, evaluateLiquidity, v4RawDetail,
  SCORE_BAND_STRONG, SCORE_BAND_MODERATE, SCORE_BAND_WEAK,
  type AdvancedSignals, type BreakoutPatterns,
} from "../_shared/market/scoring.ts";

const DEFAULT_SYMBOLS = 25;
const DEFAULT_SESSIONS = 120;
// Bars fed to the scorer for any one session. 400 comfortably covers the
// 200 EMA and the 52-week range without making each replayed session O(all
// history) — the replay is 120 scorings per symbol, so the slice size is the
// dominant cost.
const WINDOW_BARS = 400;
const UPSERT_CHUNK = 400;

const bandOf = (v: number): string =>
  v >= SCORE_BAND_STRONG ? "strong"
  : v >= SCORE_BAND_MODERATE ? "moderate"
  : v >= SCORE_BAND_WEAK ? "watch" : "weak";

const patternsOf = (p: ReturnType<typeof detectPatterns>): BreakoutPatterns => ({
  bullishEngulfing: p.bullish_engulfing,
  bearishEngulfing: p.bearish_engulfing,
  hammer: p.hammer,
  shootingStar: p.shooting_star,
  doji: p.doji,
  cupAndHandle: p.cup_and_handle,
  cupAndHandleTriggered: p.cup_and_handle_triggered,
  flag: p.flag,
  ascendingTriangle: p.ascending_triangle,
  doubleBottom: p.double_bottom,
  inverseHeadShoulders: p.inverse_head_shoulders,
  fallingWedge: p.falling_wedge,
});

interface Body { limit?: number; sessions?: number; min_rows?: number }

interface Candidate {
  symbol: string; exchange: string;
  market_cap: number | null; sector: string | null; bars: number;
}

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
    const symbolLimit = Math.max(1, Math.min(Number(body.limit ?? DEFAULT_SYMBOLS) || DEFAULT_SYMBOLS, 60));
    const sessions = Math.max(5, Math.min(Number(body.sessions ?? DEFAULT_SESSIONS) || DEFAULT_SESSIONS, 250));
    const minRows = Math.max(1, Math.min(Number(body.min_rows ?? sessions) || sessions, 400));

    const svc = svcClient();

    // Bounded drain: once the candidate set is exhausted the cron kept
    // re-running the (expensive) candidate scan every 15 minutes forever.
    // After 3 consecutive empty passes, back off for 6 hours.
    const EMPTY_STREAK_LIMIT = 3;
    const BACKOFF_HOURS = 6;
    {
      const { data: recent } = await svc.from("detection_runs")
        .select("ok,stats,created_at").eq("kind", "market-score-backfill")
        .order("created_at", { ascending: false }).limit(EMPTY_STREAK_LIMIT);
      const runs = (recent ?? []) as { stats?: { drained?: boolean }; created_at: string }[];
      const allDrained = runs.length >= EMPTY_STREAK_LIMIT && runs.every((r) => r.stats?.drained === true);
      const lastAt = runs[0] ? Date.parse(runs[0].created_at) : 0;
      if (allDrained && Date.now() - lastAt < BACKOFF_HOURS * 3600_000) {
        return jsonResponse(req, { ok: true, skipped: "drained_backoff", until_hours: BACKOFF_HOURS });
      }
    }

    const logRun = (stats: Record<string, unknown>, ok = true, error: string | null = null) =>
      svc.from("detection_runs").insert({
        kind: "market-score-backfill", finished_at: new Date().toISOString(),
        ok, error, stats,
      }).then(() => {}, () => {});

    const { data: candidates, error: candErr } = await svc.rpc("market_score_backfill_candidates", {
      _limit: symbolLimit, _min_rows: minRows,
    });
    if (candErr) return errorResponse(req, candErr.message, 500);
    const work = (candidates ?? []) as Candidate[];
    if (work.length === 0) {
      await logRun({ drained: true, symbols: 0, rows_written: 0 });
      return jsonResponse(req, { ok: true, drained: true, symbols: 0, rows_written: 0 });
    }

    let rowsWritten = 0;
    let symbolsDone = 0;
    let unscoreable = 0;
    const failures: string[] = [];

    for (const stock of work) {
      try {
        // Enough depth for the deepest session's 400-bar window.
        const need = WINDOW_BARS + sessions;
        const { data: priceRows, error: pxErr } = await svc.from("market_daily_prices")
          .select("trade_date,open,high,low,close,close_adjusted,open_adjusted,high_adjusted,low_adjusted,volume")
          .eq("symbol", stock.symbol)
          .eq("exchange", stock.exchange)
          .order("trade_date", { ascending: false })
          .limit(need);
        if (pxErr) throw pxErr;

        const candles: Candle[] = (priceRows ?? [])
          .map((p: Record<string, unknown>) => ({
            time: Math.floor(Date.parse(`${p.trade_date as string}T00:00:00Z`) / 1000),
            open: Number(p.open_adjusted ?? p.open ?? 0),
            high: Number(p.high_adjusted ?? p.high ?? 0),
            low: Number(p.low_adjusted ?? p.low ?? 0),
            close: Number(p.close_adjusted ?? p.close ?? 0),
            volume: Number(p.volume ?? 0),
          }))
          .filter((c) => Number.isFinite(c.close) && c.close > 0)
          .reverse();

        if (candles.length < 130) { symbolsDone++; continue; }

        const dates = (priceRows ?? []).map((p: Record<string, unknown>) => p.trade_date as string)
          .reverse();

        // Neutral market context — see the header. Nothing here is invented.
        const ctx = { sectorStrength: null, regime: null, relStrengthNifty: null, deliveryPct: null };

        const rows: Record<string, unknown>[] = [];
        const firstIdx = Math.max(129, candles.length - sessions);
        for (let k = firstIdx; k < candles.length; k++) {
          const slice = candles.slice(Math.max(0, k + 1 - WINDOW_BARS), k + 1);
          const snap = computeSnapshot(slice);
          if (!snap) continue;

          const weekly = computeWeeklySnapshot(slice);
          const vwapLast = vwapSeries(slice).at(-1) ?? null;
          const st = supertrend(slice);
          const flags = detectPatterns(slice);
          const adv: AdvancedSignals = {
            vwapRel: vwapLast != null && vwapLast !== 0 ? (snap.close - vwapLast) / vwapLast : null,
            supertrendDir: (st.dir.at(-1) ?? null) as 1 | -1 | null,
            mfi14: mfiSeries(slice).at(-1) ?? null,
            percentB: percentB(snap.close, snap.bbUpper, snap.bbLower),
            patterns: {
              bullishEngulfing: flags.bullish_engulfing,
              bearishEngulfing: flags.bearish_engulfing,
              hammer: flags.hammer,
              shootingStar: flags.shooting_star,
              doji: flags.doji,
              cupAndHandle: flags.cup_and_handle,
              flag: flags.flag,
              ascendingTriangle: flags.ascending_triangle,
            },
          };

          const avgTurnoverCr = snap.volAvg20 != null ? (snap.volAvg20 * snap.close) / 1e7 : null;
          const liquidity = evaluateLiquidity({
            close: snap.close,
            marketCapCr: stock.market_cap != null ? Number(stock.market_cap) : null,
            avgTurnoverCr,
          });

          const v4 = breakoutScoreV4({
            s: snap, ctx,
            patterns: patternsOf(flags),
            weekly, adv, liquidity, avgTurnoverCr,
          });
          if (v4.score == null) { unscoreable++; continue; }

          rows.push({
            symbol: stock.symbol,
            exchange: stock.exchange,
            trade_date: dates[k],
            model: "breakout_v4",
            score: v4.score,
            band: bandOf(v4.score),
            rank_pct: null,
            close: snap.close,
            buckets: v4.buckets,
            // `context: 0` is the honest statement that the sector / RS /
            // regime inputs were absent for this replayed session.
            coverage: { ...v4.coverage, context: 0 },
            // Raw 0-1 bucket values + penalty detail, same shape the live
            // pipeline writes. Without them the Calibration Lab could not
            // replay a replayed row under alternative weights.
            raw_buckets: v4RawDetail(v4),
            context_neutral: true,
            is_liquid_tradable: liquidity.ok,
          });
        }

        for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
          const { error } = await svc.from("market_score_history")
            .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: "symbol,exchange,trade_date,model" });
          if (error) throw error;
          rowsWritten += Math.min(UPSERT_CHUNK, rows.length - i);
        }
        symbolsDone++;
      } catch (err) {
        const e = err as { message?: string; details?: string; hint?: string; code?: string };
        const msg = err instanceof Error
          ? err.message
          : [e?.message, e?.details, e?.hint, e?.code].filter(Boolean).join(" | ") || JSON.stringify(err);
        if (failures.length < 10) failures.push(`${stock.symbol}: ${msg}`);
      }
    }

    // Replayed rows are written per symbol, so the day-relative rank and band
    // can only be assigned once the batch is in. Without this the whole replayed
    // history carried rank_pct = NULL.
    let ranked: number | null = null;
    try {
      const { data } = await svc.rpc("stamp_score_history_ranks", { _model: "breakout_v4" });
      ranked = typeof data === "number" ? data : null;
    } catch { /* ranking is additive — never fail the replay */ }

    const result = {
      ok: true,
      drained: false,
      ranked_rows: ranked,
      symbols: work.length,
      symbols_done: symbolsDone,
      rows_written: rowsWritten,
      unscoreable_sessions: unscoreable,
      failures,
    };
    await logRun(result, failures.length === 0, failures[0] ?? null);
    return jsonResponse(req, result);
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
