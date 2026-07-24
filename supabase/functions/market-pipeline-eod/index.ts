// market-pipeline-eod — chunked EOD pipeline. Each invocation consumes up to
// CHUNK universe stocks whose cursor is stale for today: fetch 2y daily candles
// (Yahoo), upsert market_daily_prices, compute indicators, upsert the
// market_stock_scores row (per-symbol components; sector/breadth filled by the
// aggregates pass) and chart-overlay series into market_indicators_cache.
// Cron hits this every 5 min in the evening window; it no-ops once drained.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { istTradeDate, requireCronSecret } from "../_shared/market/cron.ts";
import { computeSnapshot } from "../_shared/market/indicators.ts";
import { breakoutScore, preBreakoutScore } from "../_shared/market/scoring.ts";
import { yahooChartRetry } from "../_shared/market/yahooClient.ts";

const CHUNK = 100;
const CONCURRENCY = 5;

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const svc = svcClient();
    if (req.headers.get("x-cron-secret") != null) {
      const guard = await requireCronSecret(req);
      if (guard) return guard;
    } else {
      const auth = await requireUserId(req);
      if ("error" in auth) return auth.error;
    }

    const today = istTradeDate();
    const cutoff = `${today}T00:00:00Z`; // one pass per IST day

    const { data: stocks, error } = await svc.from("market_stocks")
      .select("symbol,exchange,yahoo_symbol,sector,last_price_sync_at,price_sync_attempts,price_sync_attempts_day")
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
    if (!stocks || stocks.length === 0) {
      return jsonResponse(req, { ok: true, processed: 0, drained: true });
    }

    let okCount = 0;
    let failCount = 0;

    const work = [...stocks];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const stock = work.shift();
        if (!stock) break;
        let success = false;
        try {
          const candles = await yahooChartRetry(stock.yahoo_symbol ?? `${stock.symbol}.NS`, "2y", "1d");
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
            await svc.from("market_provider_health").insert({
              provider: "yahoo", endpoint: "market-pipeline-eod", ok: false,
              error: `outlier rejected: ${stock.symbol} close ${snap.close} is ${snap.changePct.toFixed(1)}% from prior close — not written`,
            });
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
          await svc.from("market_daily_prices").upsert(priceRows, { onConflict: "symbol,exchange,trade_date" });

          // Preliminary scores with neutral market context (finalized by aggregates)
          const ctx = { sectorStrength: null, regime: null, relStrengthNifty: null, deliveryPct: null };
          const bs = breakoutScore(snap, ctx);
          const ps = preBreakoutScore(snap, ctx);

          await svc.from("market_stock_scores").upsert({
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
            sector: stock.sector ?? null,
            rolling_high_20: snap.rollingHigh20 ?? null,
            rolling_high_55: snap.rollingHigh55 ?? null,
            obv_slope_20: snap.obvSlope20 ?? null,
            base_tightness: snap.baseTightness ?? null,
            base_depth_pct: snap.baseDepthPct ?? null,
            base_duration_days: snap.baseDurationDays ?? null,
            close_in_range_pct: snap.closeInRangePct ?? null,
            breakout_freshness_days: snap.breakoutFreshnessDays ?? null,
            breakout_score: bs.score,
            prebreakout_score: ps.score,
            score_components: { breakout: bs.components, prebreakout: ps.components },
            computed_at: new Date().toISOString(),
          }, { onConflict: "symbol,exchange" });

          // Chart overlays: last 250 points of EMA series
          const tail = candles.slice(-250);
          const offset = candles.length - tail.length;
          const overlay = (series: (number | null)[]) =>
            tail.map((c, i) => ({ t: c.time, v: series[offset + i] }));
          await svc.from("market_indicators_cache").upsert([
            { symbol: stock.symbol, exchange: stock.exchange, timeframe: "1D", indicator: "ema20", value: overlay(snap.ema20Series), computed_at: new Date().toISOString() },
            { symbol: stock.symbol, exchange: stock.exchange, timeframe: "1D", indicator: "ema50", value: overlay(snap.ema50Series), computed_at: new Date().toISOString() },
            { symbol: stock.symbol, exchange: stock.exchange, timeframe: "1D", indicator: "ema200", value: overlay(snap.ema200Series), computed_at: new Date().toISOString() },
          ], { onConflict: "symbol,exchange,timeframe,indicator" });

          okCount++;
          success = true;
        } catch (err) {
          failCount++;
          await svc.from("market_provider_health").insert({
            provider: "yahoo", endpoint: "market-pipeline-eod", ok: false,
            error: `${stock.symbol}: ${err instanceof Error ? err.message : String(err)}`,
          });
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

    return jsonResponse(req, { ok: true, processed: stocks.length, succeeded: okCount, failed: failCount, drained: stocks.length < CHUNK });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
