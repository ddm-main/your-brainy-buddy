// market-pipeline-eod — chunked EOD pipeline. Each invocation consumes up to
// CHUNK universe stocks whose cursor is stale for today: fetch 2y daily candles
// (Yahoo), upsert market_daily_prices, compute indicators, upsert the
// market_stock_scores row (per-symbol components; sector/breadth filled by the
// aggregates pass) and chart-overlay series into market_indicators_cache.
// Cron hits this every 5 min in the evening window; it no-ops once drained.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { istTradeDate, requireCronSecret } from "../_shared/market/cron.ts";
import { computeSnapshot, computeWeeklySnapshot } from "../_shared/market/indicators.ts";
import { vwap as vwapSeries, supertrend, mfi as mfiSeries, percentB, detectPatterns } from "../_shared/market/indicators-advanced.ts";
import {
  breakoutScore, preBreakoutScore, evaluateLiquidity, swingScore, intradayScore,
  breakoutScoreV4, type AdvancedSignals,
} from "../_shared/market/scoring.ts";
import { getServiceProvider } from "../_shared/market/provider.ts";

const CHUNK = 100;
const CONCURRENCY = 3;

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const svc = svcClient();
    // Resolve the service-level provider once per invocation — this is
    // Kotak Neo whenever a connected account exists (falls back to Yahoo
    // transparently). Per-symbol getOHLCV then prefers Kotak candles for any
    // stock with an instrument token, and only spills to Yahoo when it can't.
    const { provider } = await getServiceProvider(svc);
    if (req.headers.get("x-cron-secret") != null) {
      const guard = await requireCronSecret(req);
      if (guard) return guard;
    } else {
      const auth = await requireUserId(req);
      if ("error" in auth) return auth.error;
    }

    const today = istTradeDate();
    const cutoff = `${today}T00:00:00Z`; // one pass per IST day

    // Cheap recovery path: if daily prices have already landed (NSE bhavcopy,
    // backfill, or another provider run) but scores are behind, rebuild scores
    // from stored prices first. This avoids burning egress on another full
    // candle fetch and prevents a cursor from being marked fresh while the
    // score table remains stale.
    let localRescored = 0;
    const [{ data: latestPrice }, { data: latestScore }] = await Promise.all([
      svc.from("market_daily_prices").select("trade_date").eq("exchange", "NSE")
        .order("trade_date", { ascending: false }).limit(1).maybeSingle(),
      svc.from("market_stock_scores").select("trade_date").eq("exchange", "NSE")
        .order("trade_date", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const latestPriceDate = latestPrice?.trade_date as string | undefined;
    const latestScoreDate = latestScore?.trade_date as string | undefined;
    if (latestPriceDate && (!latestScoreDate || latestPriceDate > latestScoreDate)) {
      const { data: rows, error: rescoreErr } = await svc.rpc("market_rescore_latest_from_prices", {
        _trade_date: latestPriceDate,
        _limit: 3000,
      });
      if (rescoreErr) {
        await svc.from("market_provider_health").insert({
          provider: "postgres",
          endpoint: "market-pipeline-eod",
          ok: false,
          error: `price-table rescore failed: ${rescoreErr.message}`,
        });
      } else {
        localRescored = typeof rows === "number" ? rows : 0;
      }
    }

    const { data: stocks, error } = await svc.from("market_stocks")
      .select("symbol,exchange,yahoo_symbol,sector,market_cap,last_price_sync_at,price_sync_attempts,price_sync_attempts_day")
      .eq("is_active", true)
      .eq("exchange", "NSE")
      .or(`last_price_sync_at.is.null,last_price_sync_at.lt.${cutoff}`)
      // Cap same-day retries at 3 per symbol so a permanently-broken symbol
      // (renamed, delisted, thin Yahoo data) can't wedge the chunk — but a
      // transient 429/timeout no longer permanently freezes the row on
      // yesterday's data (root cause of stale rows leaking into the screener).
      .or(`price_sync_attempts_day.neq.${today},price_sync_attempts.lt.3`)
      .order("last_price_sync_at", { ascending: true, nullsFirst: true })
      .limit(CHUNK);
    if (error) return errorResponse(req, error.message, 500);

    // ---- Enrichment top-up ----
    // The cheap SQL rescore path (and the NSE bhavcopy sync) can mark a symbol
    // "priced today" without ever computing the candle-derived fields —
    // pivot level, volume dry-up, weekly confirmation, VWAP/Supertrend/MFI and
    // candle patterns. Those rows then score with whole factor buckets stuck
    // at zero (which is why the universe topped out in the 60s and nothing
    // reached the 70 "strong" band). If the staleness picker didn't fill the
    // chunk, spend the remaining budget on symbols whose scores are missing
    // that enrichment, so every name eventually gets a full-fidelity pass.
    const candidates = [...(stocks ?? [])];
    if (candidates.length < CHUNK) {
      const have = new Set(candidates.map((s) => `${s.symbol}|${s.exchange}`));
      const room = CHUNK - candidates.length;
      const { data: bare } = await svc.from("market_stock_scores")
        .select("symbol,exchange")
        .eq("exchange", "NSE")
        .or("pivot_level.is.null,weekly_close.is.null")
        .order("computed_at", { ascending: true, nullsFirst: true })
        .limit(room * 3);
      const wanted = (bare ?? []).filter((b) => !have.has(`${b.symbol}|${b.exchange}`)).slice(0, room);
      if (wanted.length) {
        const { data: enrich } = await svc.from("market_stocks")
          .select("symbol,exchange,yahoo_symbol,sector,market_cap,last_price_sync_at,price_sync_attempts,price_sync_attempts_day")
          .eq("is_active", true)
          .eq("exchange", "NSE")
          .in("symbol", wanted.map((w) => w.symbol));
        for (const e of enrich ?? []) {
          if (!have.has(`${e.symbol}|${e.exchange}`)) { candidates.push(e); have.add(`${e.symbol}|${e.exchange}`); }
        }
      }
    }
    if (candidates.length === 0) {
      return jsonResponse(req, { ok: true, processed: 0, drained: true });
    }


    let okCount = 0;
    let failCount = 0;
    // market-pipeline-aggregates is the authoritative score writer: it is the
    // only pass that knows sector strength, breadth regime and relative
    // strength. This chunked pass keeps draining for hours afterwards on cron
    // and used to re-write those rows with a neutral, context-free score —
    // which is why 99.7% of the universe carried context_complete = false and
    // nothing could reach the 70 band. Load what already exists for the chunk
    // and write ONLY indicators for symbols already scored with full context
    // for the same session.
    const existingScore = new Map<string, { trade_date: string | null; context_complete: boolean }>();
    {
      const syms = candidates.map((s) => s.symbol);
      for (let i = 0; i < syms.length; i += 200) {
        const { data } = await svc.from("market_stock_scores")
          .select("symbol,exchange,trade_date,context_complete")
          .in("symbol", syms.slice(i, i + 200));
        for (const d of data ?? []) {
          existingScore.set(`${d.symbol}|${d.exchange}`, {
            trade_date: d.trade_date ?? null,
            context_complete: !!d.context_complete,
          });
        }
      }
    }
    let contextPreserved = 0;
    // Per-symbol coverage failures ("insufficient candles", Yahoo 404 on a
    // delisted ticker) are NOT provider outages, and writing one health row
    // per symbol both slandered the broker on the Providers page (617 rows in
    // 24h attributed to kotak_neo for symbols it never served) and burned
    // disk. Collect them and write ONE summary row for the run instead.
    const symbolErrors: string[] = [];

    const work = [...candidates];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const stock = work.shift();
        if (!stock) break;
        let success = false;
        try {
          const candles = await provider.getOHLCV(stock.symbol, stock.exchange ?? "NSE", "2y", "1d");
          if (candles.length < 30) throw new Error("insufficient candles");

          const snap = computeSnapshot(candles);
          if (!snap) throw new Error("snapshot failed");

          // Outlier guard: a >40% single-session move is far more often a bad
          // upstream tick (wrong decimal place, stale/wrong-symbol response)
          // than a real move — NSE's circuit limits keep most genuine daily
          // moves well under this. Reject before writing anything (daily
          // prices included), and log the anomaly so it's visible instead of
          // silently corrupting the stored series.
          if (snap.changePct != null && Math.abs(snap.changePct) > 40) {
            symbolErrors.push(`outlier rejected: ${stock.symbol} close ${snap.close} is ${snap.changePct.toFixed(1)}% from prior close — not written`);
            throw new Error("price outlier rejected");
          }

          const nseTradeDate = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);

          // Last ~30 sessions into market_daily_prices
          const priceRows = candles.slice(-30).map((c) => ({
            symbol: stock.symbol,
            exchange: stock.exchange,
            trade_date: new Date(c.time * 1000).toISOString().slice(0, 10),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          }));
          const { error: priceErr } = await svc.from("market_daily_prices")
            .upsert(priceRows, { onConflict: "symbol,exchange,trade_date" });
          if (priceErr) throw priceErr;

          // v3 — weekly confirmation (resampled from the same 2y daily candles
          // already fetched, no new data source) + advanced signals
          // (vwap/supertrend/mfi/%B/patterns — computed by indicators-advanced.ts
          // since forever, never wired to anything until now).
          const weekly = computeWeeklySnapshot(candles);
          const vwapLast = vwapSeries(candles).at(-1) ?? null;
          const st = supertrend(candles);
          const supertrendDir = (st.dir.at(-1) ?? null) as 1 | -1 | null;
          const mfi14 = mfiSeries(candles).at(-1) ?? null;
          const bbPercentB = percentB(snap.close, snap.bbUpper, snap.bbLower);
          const patternFlags = detectPatterns(candles);
          const adv: AdvancedSignals = {
            vwapRel: vwapLast != null && vwapLast !== 0 ? (snap.close - vwapLast) / vwapLast : null,
            supertrendDir,
            mfi14,
            percentB: bbPercentB,
            patterns: {
              bullishEngulfing: patternFlags.bullish_engulfing,
              bearishEngulfing: patternFlags.bearish_engulfing,
              hammer: patternFlags.hammer,
              shootingStar: patternFlags.shooting_star,
              doji: patternFlags.doji,
              cupAndHandle: patternFlags.cup_and_handle,
              flag: patternFlags.flag,
              ascendingTriangle: patternFlags.ascending_triangle,
            },
          };

          // Liquidity gate — market_cap here is market_stocks' plain column
          // (cheap, same-table), a cruder estimate than the screener view's
          // multi-source fallback (consensus/shares-outstanding/fundamentals)
          // but good enough for a pass/fail gate, not for display.
          const avgTurnoverCr = snap.volAvg20 != null ? (snap.volAvg20 * snap.close) / 1e7 : null;
          const liquidity = evaluateLiquidity({
            close: snap.close,
            marketCapCr: stock.market_cap != null ? Number(stock.market_cap) : null,
            avgTurnoverCr,
          });

          // Preliminary scores with neutral market context (finalized by aggregates)
          const ctx = { sectorStrength: null, regime: null, relStrengthNifty: null, deliveryPct: null };
          // Feed the tightened detectPatterns output into breakoutScore so
          // the pattern component, context-aware bonuses, and bearish-at-R
          // penalty land in the persisted score components.
          const bs = breakoutScore(snap, ctx, {
            bullishEngulfing: patternFlags.bullish_engulfing,
            bearishEngulfing: patternFlags.bearish_engulfing,
            hammer: patternFlags.hammer,
            shootingStar: patternFlags.shooting_star,
            doji: patternFlags.doji,
            cupAndHandle: patternFlags.cup_and_handle,
            cupAndHandleTriggered: patternFlags.cup_and_handle_triggered,
            flag: patternFlags.flag,
            ascendingTriangle: patternFlags.ascending_triangle,
            doubleBottom: patternFlags.double_bottom,
            inverseHeadShoulders: patternFlags.inverse_head_shoulders,
            fallingWedge: patternFlags.falling_wedge,
          });
          const ps = preBreakoutScore(snap, ctx);

          // v3 — swing/intraday. This EOD pass has only the day's already-closed
          // candle, so intraday_score here is "how strong was TODAY's now-closed
          // session on an intraday-momentum basis" (real gap, full-day relVolume)
          // — a persisted baseline. The genuinely live, time-of-day-normalized
          // version is computed client-side during market hours (liveSnapshot.ts),
          // never persisted.
          const prevCandle = candles[candles.length - 2];
          const gapPct = prevCandle?.close ? ((candles[candles.length - 1].open - prevCandle.close) / prevCandle.close) * 100 : null;
          const sw = swingScore({ s: snap, ctx, weekly, adv, liquidity });
          const is = intradayScore({ s: snap, ctx, adv, liquidity, relVolumeSoFar: null, gapPct });

          // Preliminary v4 — neutral context, so the sector/RS/breadth bucket
          // is simply *absent* and its weight is redistributed rather than
          // scored as zero. The aggregates pass recomputes it with real context.
          const v4 = breakoutScoreV4({
            s: snap,
            ctx,
            patterns: {
              bullishEngulfing: patternFlags.bullish_engulfing,
              bearishEngulfing: patternFlags.bearish_engulfing,
              hammer: patternFlags.hammer,
              shootingStar: patternFlags.shooting_star,
              doji: patternFlags.doji,
              cupAndHandle: patternFlags.cup_and_handle,
              cupAndHandleTriggered: patternFlags.cup_and_handle_triggered,
              flag: patternFlags.flag,
              ascendingTriangle: patternFlags.ascending_triangle,
              doubleBottom: patternFlags.double_bottom,
              inverseHeadShoulders: patternFlags.inverse_head_shoulders,
              fallingWedge: patternFlags.falling_wedge,
            },
            weekly,
            adv,
            liquidity,
            avgTurnoverCr,
          });

          const prior = existingScore.get(`${stock.symbol}|${stock.exchange}`);
          const keepContext = !!prior?.context_complete && prior.trade_date === nseTradeDate;
          if (keepContext) contextPreserved++;

          const scoreFields = keepContext ? {} : {
            breakout_score: bs.score,
            prebreakout_score: ps.score,
            score_components: { breakout: bs.components, prebreakout: ps.components },
            breakout_score_v4: v4.score,
            breakout_v4_components: { buckets: v4.buckets, factors: v4.components, penalties: v4.penalties },
            breakout_v4_coverage: v4.coverage,
            score_unavailable_reason: v4.unavailableReason,
            swing_score: sw.score,
            swing_components: sw.components,
            intraday_score: is.score,
            intraday_components: is.components,
            // Neutral-context preliminary write; market-pipeline-aggregates
            // recomputes with real sector/RS/regime context and flips this true.
            context_complete: false,
          };

          const { error: scoreErr } = await svc.from("market_stock_scores").upsert({
            symbol: stock.symbol,
            exchange: stock.exchange,
            trade_date: nseTradeDate,
            close: snap.close,
            change_pct: snap.changePct,
            // The screener universe is NSE. Keep this value NSE-only so price,
            // return, current volume and the 30-session baseline share a source.
            volume: snap.volume,
            volume_nse: snap.volume,
            volume_bse: null,
            vol_avg20: snap.volAvg20,
            vol_avg30: snap.volAvg30,
            rel_volume: snap.relVolume,
            ema20: snap.ema20,
            ema50: snap.ema50,
            ema100: snap.ema100,
            ema200: snap.ema200,
            rsi14: snap.rsi14,
            macd: snap.macd,
            macd_signal: snap.macdSignal,
            macd_hist: snap.macdHist,
            adx14: snap.adx14,
            atr14: snap.atr14,
            atr_pct: snap.atrPct,
            bb_upper: snap.bbUpper,
            bb_lower: snap.bbLower,
            bb_width: snap.bbWidth,
            bb_squeeze: snap.bbSqueeze,
            high_52w: snap.high52w,
            low_52w: snap.low52w,
            pct_from_52w_high: snap.pctFrom52wHigh,
            above_ema200: snap.aboveEma200,
            higher_lows: snap.higherLows,
            near_resistance: snap.nearResistance,
            resistance_level: snap.resistance,
            support_level: snap.support,
            // Round-trip fidelity: market-pipeline-aggregates re-scores v4 from
            // these columns alone. Anything the scorer reads and we don't store
            // is silently dropped from the score the UI shows.
            support_fallback: snap.supportFallback ?? null,
            resistance_fallback: snap.resistanceFallback ?? null,
            resistance_above: snap.resistanceAbove ?? null,
            breakout_state: snap.breakoutStateKind ?? null,
            breakout_level_cleared: snap.breakoutLevelCleared ?? null,
            rolling_high_20_touches: snap.rollingHigh20Touches ?? null,
            rolling_high_20_touch_quality: snap.rollingHigh20TouchQuality ?? null,
            macd_hist_rising: snap.macdHistRising ?? null,
            atr_contracting: snap.atrContracting ?? null,
            sector: stock.sector ?? null,
            rolling_high_20: snap.rollingHigh20 ?? null,
            rolling_high_55: snap.rollingHigh55 ?? null,
            obv_slope_20: snap.obvSlope20 ?? null,
            base_tightness: snap.baseTightness ?? null,
            base_depth_pct: snap.baseDepthPct ?? null,
            base_duration_days: snap.baseDurationDays ?? null,
            close_in_range_pct: snap.closeInRangePct ?? null,
            breakout_freshness_days: snap.breakoutFreshnessDays ?? null,
            // Age of the CURRENT state, fresh or failed. breakout_freshness_days
            // is only set while a breakout is alive, so without this a failed
            // breakout lost its age on the DB round-trip and the recency-scoped
            // failed_breakout penalty could never fire in the aggregates pass.
            breakout_state_days: snap.breakoutStateDays ?? null,
            pivot_level: snap.pivotLevel ?? null,
            pivot_touches: snap.pivotTouches ?? null,
            pivot_touch_quality: snap.pivotTouchQuality ?? null,
            rel_volume_median30: snap.relVolumeMedian30 ?? null,
            bars_available: snap.barsAvailable ?? candles.length,
            vol_dryup_ratio: snap.volDryUpRatio ?? null,
            vol_dryup_ratio_base: snap.volDryUpRatioBase ?? null,
            ema_cross_20_50_days: snap.emaCross2050FreshDays ?? null,
            ema_cross_50_200_days: snap.emaCross50200FreshDays ?? null,
            // True 55-session return. Relative strength compares this against
            // the Nifty's own 55-session return — same horizon, both sides.
            ret_55d: (() => {
              const base = candles[candles.length - 56];
              const last = candles[candles.length - 1];
              return base && last && base.close > 0
                ? ((last.close - base.close) / base.close) * 100
                : null;
            })(),

            // v3 additions — additive, breakout_score/prebreakout_score above unchanged.
            weekly_close: weekly?.closeW ?? null,
            weekly_ema20: weekly?.ema20W ?? null,
            weekly_rsi14: weekly?.rsi14W ?? null,
            weekly_trend_up: weekly?.trendUpW ?? null,
            weekly_higher_lows: weekly?.higherLowsW ?? null,
            weekly_bars: weekly?.barsW ?? null,
            vwap: vwapLast,
            supertrend: st.line.at(-1) ?? null,
            supertrend_dir: supertrendDir,
            mfi14,
            bb_percent_b: bbPercentB,
            pattern_flags: patternFlags,
            is_liquid_tradable: liquidity.ok,
            liquidity_reasons: liquidity.reasons,
            // This pass wrote today's bar, so the row is current by definition.
            is_stale: false,
            ...scoreFields,
            computed_at: new Date().toISOString(),
          }, { onConflict: "symbol,exchange" });
          if (scoreErr) throw scoreErr;

          // Chart overlays: last 250 points of EMA series
          const tail = candles.slice(-250);
          const offset = candles.length - tail.length;
          const overlay = (series: (number | null)[]) =>
            tail.map((c, i) => ({ t: c.time, v: series[offset + i] }));
          const { error: indicatorErr } = await svc.from("market_indicators_cache").upsert([
            { symbol: stock.symbol, exchange: stock.exchange, timeframe: "1D", indicator: "ema20", value: overlay(snap.ema20Series), computed_at: new Date().toISOString() },
            { symbol: stock.symbol, exchange: stock.exchange, timeframe: "1D", indicator: "ema50", value: overlay(snap.ema50Series), computed_at: new Date().toISOString() },
            { symbol: stock.symbol, exchange: stock.exchange, timeframe: "1D", indicator: "ema200", value: overlay(snap.ema200Series), computed_at: new Date().toISOString() },
          ], { onConflict: "symbol,exchange,timeframe,indicator" });
          if (indicatorErr) throw indicatorErr;

          okCount++;
          success = true;
        } catch (err) {
          failCount++;
          // Supabase throws plain objects (PostgrestError), not Errors, so
          // `String(err)` rendered every DB failure as the useless literal
          // "[object Object]" — which is exactly what this table has been
          // recording. Pull the real message/details out instead.
          const detail = err instanceof Error
            ? err.message
            : (err && typeof err === "object"
              ? [(err as any).message, (err as any).details, (err as any).hint, (err as any).code]
                .filter(Boolean).join(" | ") || JSON.stringify(err).slice(0, 300)
              : String(err));
          if (symbolErrors.length < 50) symbolErrors.push(`${stock.symbol}: ${detail}`);
        } finally {
          // Success: mark sync fresh and reset the attempt counter.
          // Failure: bump attempts (capped by the outer picker at 3/day) but
          //          DO NOT advance last_price_sync_at, so the next chunk
          //          re-selects this symbol instead of freezing yesterday's row.
          if (success) {
            await svc.from("market_stocks")
              .update({
                last_price_sync_at: new Date().toISOString(),
                price_sync_attempts: 0,
                price_sync_attempts_day: today,
              })
              .eq("symbol", stock.symbol)
              .eq("exchange", stock.exchange);
          } else {
            const nextAttempts = stock.price_sync_attempts_day === today
              ? (stock.price_sync_attempts ?? 0) + 1
              : 1;
            await svc.from("market_stocks")
              .update({
                price_sync_attempts: nextAttempts,
                price_sync_attempts_day: today,
              })
              .eq("symbol", stock.symbol)
              .eq("exchange", stock.exchange);
          }
        }
      }
    });
    await Promise.all(workers);

    // One row for the whole run, attributed to the pipeline (not the broker).
    if (symbolErrors.length > 0) {
      await svc.from("market_provider_health").insert({
        provider: "pipeline",
        endpoint: "market-pipeline-eod",
        ok: false,
        error: `${failCount} of ${candidates.length} symbols failed — ${symbolErrors.slice(0, 10).join(" ; ")}`.slice(0, 500),
      });
    }

    return jsonResponse(req, { ok: true, processed: candidates.length, succeeded: okCount, failed: failCount, symbol_errors: symbolErrors.slice(0, 20), context_preserved: contextPreserved, local_rescored: localRescored, drained: candidates.length < CHUNK });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
