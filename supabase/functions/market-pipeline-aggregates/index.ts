// market-pipeline-aggregates — after the EOD pass: compute market breadth,
// sector strength ranks, relative strength vs NIFTY, then re-score every stock
// with full market context.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { istTradeDate, requireCronSecret } from "../_shared/market/cron.ts";
import {
  classifyRegime, breakoutScore, preBreakoutScore,
  evaluateLiquidity, swingScore, intradayScore,
  BREAKOUT_QUALIFY_SCORE, SCORE_TREND_CAP,
  breakoutFollowThroughScore, nextEpisodeStatus,
  type AdvancedSignals, type BreakoutStatus,
} from "../_shared/market/scoring.ts";
import type { IndicatorSnapshot, WeeklySnapshot } from "../_shared/market/indicators.ts";
import { yahooChartRetry } from "../_shared/market/yahooClient.ts";
import { getServiceProvider } from "../_shared/market/provider.ts";

// Rebuild the scorer's input from a market_stock_scores row (joined with stocks).
// v2 fix: `atrContracting` and `macdHistRising` used to be read from yesterday's
// `score_components`, which is circular (score → components → tomorrow's score).
// Derive them from raw indicator columns instead so today's score reflects
// today's tape.
function snapFromRow(r: any): IndicatorSnapshot {
  // bb_width < 0.06 (~6% of price) is a reasonable "squeeze / contracting"
  // proxy when a rolling bbWidth history isn't in the row.
  const bbw = typeof r.bb_width === "number" ? r.bb_width : null;
  const atrContracting = bbw != null ? bbw < 0.06 : false;
  const macdHistRising = typeof r.macd_hist === "number" && r.macd_hist > 0;
  return {
    close: r.close ?? 0,
    changePct: r.change_pct,
    volume: r.volume ?? 0,
    volAvg20: r.vol_avg20,
    volAvg30: r.vol_avg30 ?? null,
    relVolume: r.rel_volume,
    ema20: r.ema20,
    ema50: r.ema50,
    ema100: r.ema100,
    ema200: r.ema200,
    rsi14: r.rsi14,
    macd: r.macd,
    macdSignal: r.macd_signal,
    macdHist: r.macd_hist,
    adx14: r.adx14,
    atr14: r.atr14,
    atrPct: r.atr_pct,
    bbUpper: r.bb_upper,
    bbLower: r.bb_lower,
    bbWidth: r.bb_width,
    bbSqueeze: !!r.bb_squeeze,
    atrContracting,
    high52w: r.high_52w,
    low52w: r.low_52w,
    pctFrom52wHigh: r.pct_from_52w_high,
    aboveEma200: !!r.above_ema200,
    emaAligned: r.ema20 != null && r.ema50 != null && r.ema200 != null && r.ema20 > r.ema50 && r.ema50 > r.ema200,
    higherLows: !!r.higher_lows,
    support: r.support_level,
    resistance: r.resistance_level,
    nearResistance: !!r.near_resistance,
    macdHistRising,
    rollingHigh20: r.rolling_high_20 ?? null,
    rollingHigh55: r.rolling_high_55 ?? null,
    obvSlope20: r.obv_slope_20 ?? null,
    baseTightness: r.base_tightness ?? null,
    baseDepthPct: r.base_depth_pct ?? null,
    baseDurationDays: r.base_duration_days ?? null,
    rsPercentile: r.rs_percentile ?? null,
    closeInRangePct: r.close_in_range_pct ?? null,
    breakoutFreshnessDays: r.breakout_freshness_days ?? null,
    ema20Series: [],
    ema50Series: [],
    ema200Series: [],
  };
}

// v3 — reconstruct the weekly/advanced-signal inputs swingScore/intradayScore
// need from what market-pipeline-eod already persisted this same run, rather
// than re-fetching candles (this pass deliberately works only from already-
// persisted columns, same rationale as snapFromRow above).
function weeklyFromRow(r: any): WeeklySnapshot | null {
  if (r.weekly_close == null) return null;
  return {
    closeW: r.weekly_close,
    ema20W: r.weekly_ema20 ?? null,
    rsi14W: r.weekly_rsi14 ?? null,
    aboveEma20W: !!r.weekly_ema20 && r.weekly_close > r.weekly_ema20,
    trendUpW: !!r.weekly_trend_up,
    higherLowsW: !!r.weekly_higher_lows,
    barsW: 0,
  };
}

function advFromRow(r: any): AdvancedSignals {
  const vwapV = r.vwap ?? null;
  return {
    vwapRel: vwapV != null && vwapV !== 0 && r.close != null ? (r.close - vwapV) / vwapV : null,
    supertrendDir: r.supertrend_dir ?? null,
    mfi14: r.mfi14 ?? null,
    percentB: r.bb_percent_b ?? null,
    patterns: {
      bullishEngulfing: !!r.pattern_flags?.bullish_engulfing,
      bearishEngulfing: !!r.pattern_flags?.bearish_engulfing,
      hammer: !!r.pattern_flags?.hammer,
      shootingStar: !!r.pattern_flags?.shooting_star,
      doji: !!r.pattern_flags?.doji,
      cupAndHandle: !!r.pattern_flags?.cup_and_handle,
      flag: !!r.pattern_flags?.flag,
      ascendingTriangle: !!r.pattern_flags?.ascending_triangle,
    },
  };
}

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

    // Pull all scored rows, then join sector/is_active/market_cap from
    // market_stocks in-memory (no FK between the two tables, so PostgREST
    // embeds fail).
    const stockMeta = new Map<string, { sector: string | null; is_active: boolean; market_cap: number | null }>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await svc.from("market_stocks")
        .select("symbol,exchange,sector,is_active,market_cap")
        .range(from, from + 999);
      if (error) return errorResponse(req, error.message, 500);
      for (const d of data ?? []) {
        stockMeta.set(`${d.symbol}|${d.exchange}`, { sector: d.sector ?? null, is_active: !!d.is_active, market_cap: d.market_cap != null ? Number(d.market_cap) : null });
      }
      if (!data || data.length < 1000) break;
    }

    const rows: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await svc.from("market_stock_scores")
        .select("*")
        .not("trade_date", "is", null)
        .range(from, from + 999);
      if (error) return errorResponse(req, error.message, 500);
      for (const d of data ?? []) {
        const meta = stockMeta.get(`${d.symbol}|${d.exchange}`);
        if (!meta || !meta.is_active) continue;
        rows.push({ ...d, sector: d.sector ?? meta.sector ?? null, market_cap: meta.market_cap });
      }
      if (!data || data.length < 1000) break;
    }
    if (rows.length === 0) return jsonResponse(req, { ok: true, note: "no trade data yet — run market-pipeline-eod first" });

    // ---- Breadth ----
    const advances = rows.filter((r) => (r.change_pct ?? 0) > 0).length;
    const declines = rows.filter((r) => (r.change_pct ?? 0) < 0).length;
    const unchanged = rows.length - advances - declines;
    const pctAbove = (key: string) =>
      (rows.filter((r) => r[key] != null && r.close != null && r.close > r[key]).length / rows.length) * 100;
    const pctAboveEma20 = pctAbove("ema20");
    const pctAboveEma50 = pctAbove("ema50");
    const pctAboveEma200 = pctAbove("ema200");
    const rsiVals = rows.map((r) => r.rsi14).filter((v: number | null): v is number => v != null);
    const avgRsi = rsiVals.length ? rsiVals.reduce((a: number, b: number) => a + b, 0) / rsiVals.length : null;
    const regime = classifyRegime(pctAboveEma50, avgRsi);

    // NIFTY context (also used for relative strength).
    // Prefer Kotak Neo daily candles when any user has an active session
    // (getServiceProvider picks the most-recently-updated connected Kotak
    // row). Falls back to Yahoo when no Kotak session is available — this
    // is a cron path with no user context, so Kotak may legitimately not
    // be reachable and Yahoo's daily NIFTY close is fine for breadth.
    let niftyClose: number | null = null;
    let niftyChangePct: number | null = null;
    let niftyReturn55: number | null = null;
    try {
      const { provider } = await getServiceProvider(svc);
      let nifty: Array<{ close: number }> = [];
      let providerErr: string | null = null;
      try {
        nifty = await provider.getOHLCV("NIFTY", "NSE", "6mo", "1d");
      } catch (e) {
        providerErr = e instanceof Error ? e.message : String(e);
      }
      if (nifty.length < 2) {
        // Kotak branch failed or returned nothing — log the true origin
        // (provider name) before falling back to Yahoo so provenance is visible.
        await svc.from("market_provider_health").insert({
          provider: (provider as any).name ?? "unknown",
          endpoint: "market-pipeline-aggregates",
          ok: false,
          latency_ms: 0,
          error: (providerErr ?? "empty candles from primary — falling back to yahoo").slice(0, 500),
        }).then(() => {}, () => {});
        nifty = await yahooChartRetry("^NSEI", "6mo", "1d");
      }
      const last = nifty[nifty.length - 1];
      const prev = nifty[nifty.length - 2];
      niftyClose = last?.close ?? null;
      niftyChangePct = last && prev ? ((last.close - prev.close) / prev.close) * 100 : null;
      const base = nifty[Math.max(0, nifty.length - 56)];
      niftyReturn55 = last && base ? ((last.close - base.close) / base.close) * 100 : null;
    } catch { /* breadth still useful without NIFTY */ }


    await svc.from("market_breadth_daily").upsert({
      trade_date: today,
      advances,
      declines,
      unchanged,
      pct_above_ema20: pctAboveEma20,
      pct_above_ema50: pctAboveEma50,
      pct_above_ema200: pctAboveEma200,
      avg_rsi: avgRsi,
      nifty_close: niftyClose,
      nifty_change_pct: niftyChangePct,
      regime,
      computed_at: new Date().toISOString(),
    }, { onConflict: "trade_date" });

    // ---- Sector strength ----
    const bySector = new Map<string, any[]>();
    for (const r of rows) {
      const sec = r.sector || "Unknown";
      if (!bySector.has(sec)) bySector.set(sec, []);
      bySector.get(sec)!.push(r);
    }
    const sectorStats = [...bySector.entries()].map(([sector, list]) => {
      const chg = list.map((r) => r.change_pct).filter((v): v is number => v != null);
      const rsis = list.map((r) => r.rsi14).filter((v): v is number => v != null);
      const above50 = list.filter((r) => r.ema50 != null && r.close != null && r.close > r.ema50).length;
      return {
        sector,
        stock_count: list.length,
        avg_change_pct: chg.length ? chg.reduce((a, b) => a + b, 0) / chg.length : null,
        avg_rsi: rsis.length ? rsis.reduce((a, b) => a + b, 0) / rsis.length : null,
        pct_above_ema50: (above50 / list.length) * 100,
      };
    });
    sectorStats.sort((a, b) => (b.avg_change_pct ?? -99) - (a.avg_change_pct ?? -99));
    const sectorRank = new Map<string, number>();
    const sectorRows = sectorStats.map((s, i) => {
      sectorRank.set(s.sector, i + 1);
      return { ...s, trade_date: today, strength_rank: i + 1, computed_at: new Date().toISOString() };
    });
    if (sectorRows.length > 0) {
      await svc.from("market_sector_strength_daily").upsert(sectorRows, { onConflict: "trade_date,sector" });
    }
    const nSectors = sectorStats.length || 1;

    // ---- RS percentile ranks over universe (based on ema50-anchored return) ----
    const rsInputs: { key: string; rs: number }[] = [];
    for (const r of rows) {
      if (r.close != null && r.ema50 != null && r.ema50 !== 0) {
        const base = r.ema100 ?? r.ema50;
        const stockTrendPct = ((r.close - base) / base) * 100;
        rsInputs.push({ key: `${r.symbol}|${r.exchange}`, rs: stockTrendPct });
      }
    }
    rsInputs.sort((a, b) => a.rs - b.rs);
    const rsPct = new Map<string, number>();
    const n = rsInputs.length;
    rsInputs.forEach((it, idx) => {
      rsPct.set(it.key, n > 1 ? Math.round((idx / (n - 1)) * 1000) / 10 : 50);
    });

    // ---- Final scoring with market context ----
    // Collect each row's freshly-computed scores so the breakout-tracking pass
    // below can snapshot them — the DB update writes the new values but the
    // in-memory `r` still holds the pre-rescore breakout_score.
    interface Scored {
      symbol: string; exchange: string;
      close: number | null; market_cap: number | null;
      sector: string | null; rel_volume: number | null;
      breakout: number; prebreakout: number; swing: number;
      liquidityOk: boolean; components: unknown;
    }
    const scored: Scored[] = [];
    let updated = 0;
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      await Promise.all(batch.map(async (r) => {
        const rank = sectorRank.get(r.sector || "Unknown");
        const sectorStrength = rank != null && nSectors > 1 ? 1 - (rank - 1) / (nSectors - 1) : 0.5;
        let relStrength: number | null = null;
        if (niftyReturn55 != null && r.close != null && r.ema50 != null && r.ema50 !== 0) {
          const base = r.ema100 ?? r.ema50;
          const stockTrendPct = ((r.close - base) / base) * 100;
          relStrength = stockTrendPct - (niftyClose != null && niftyReturn55 != null ? niftyReturn55 * 0.5 : 0);
        }
        const rsPercentile = rsPct.get(`${r.symbol}|${r.exchange}`) ?? null;
        const snap = { ...snapFromRow(r), rsPercentile };
        const ctx = { sectorStrength, regime, relStrengthNifty: relStrength, deliveryPct: null };
        const bs = breakoutScore(snap, ctx);
        const ps = preBreakoutScore(snap, ctx);
        const scoreComponents = { breakout: bs.components, prebreakout: ps.components };

        // v3 — re-score swing/intraday with the same real market context
        // breakout/prebreakout just got, mirroring the eod pass's preliminary
        // (neutral-context) computation. gapPct/relVolumeSoFar aren't
        // available here (no candles in this pass) — intraday_score drops
        // those two factors' contribution in this refinement, same
        // graceful-degradation approach the rest of this pipeline already
        // uses for optional fields.
        const avgTurnoverCr = r.vol_avg20 != null && r.close != null ? (r.vol_avg20 * r.close) / 1e7 : null;
        const liquidity = evaluateLiquidity({ close: r.close, marketCapCr: r.market_cap, avgTurnoverCr });
        const weekly = weeklyFromRow(r);
        const adv = advFromRow(r);
        const sw = swingScore({ s: snap, ctx, weekly, adv, liquidity });
        const is = intradayScore({ s: snap, ctx, adv, liquidity, relVolumeSoFar: null, gapPct: null });

        const nowIso = new Date().toISOString();
        const { error } = await svc.from("market_stock_scores").update({
          sector_strength: Math.round(sectorStrength * 100) / 100,
          rel_strength_nifty: relStrength != null ? Math.round(relStrength * 100) / 100 : null,
          rs_percentile: rsPercentile,
          breakout_score: bs.score,
          prebreakout_score: ps.score,
          score_components: scoreComponents,
          is_liquid_tradable: liquidity.ok,
          liquidity_reasons: liquidity.reasons,
          swing_score: sw.score,
          swing_components: sw.components,
          intraday_score: is.score,
          intraday_components: is.components,
          computed_at: nowIso,
        }).eq("symbol", r.symbol).eq("exchange", r.exchange);
        if (!error) updated++;

        scored.push({
          symbol: r.symbol, exchange: r.exchange,
          close: r.close ?? null, market_cap: r.market_cap ?? null,
          sector: r.sector ?? null, rel_volume: r.rel_volume ?? null,
          breakout: bs.score, prebreakout: ps.score, swing: sw.score,
          liquidityOk: liquidity.ok, components: scoreComponents,
        });
      }));
    }

    // ---- Breakout tracking: daily snapshot + multi-day episode maintenance ----
    // Re-checks every open episode (yesterday's picks) and opens fresh episodes
    // for today's new qualifiers, so a stock flagged earlier keeps being
    // followed forward alongside the day's new breakouts. Idempotent per day:
    // re-runs on the same trade_date refresh values without double-counting
    // days_tracked or re-appending the score trend.
    const tracking = { snapshots: 0, opened: 0, updated_ep: 0, failed: 0, closed: 0 };
    try {
      const qualifiers = scored.filter(
        (x) => x.close != null && x.liquidityOk && x.breakout >= BREAKOUT_QUALIFY_SCORE,
      );
      const scoredByKey = new Map(scored.map((x) => [`${x.symbol}|${x.exchange}`, x]));

      // 1. Snapshot today's qualifiers (per-symbol daily score history).
      const snapRows = qualifiers.map((x) => ({
        symbol: x.symbol, exchange: x.exchange, trade_date: today,
        breakout_score: x.breakout, prebreakout_score: x.prebreakout, swing_score: x.swing,
        close: x.close, market_cap: x.market_cap, sector: x.sector,
        rel_volume: x.rel_volume, regime, components: x.components,
        computed_at: new Date().toISOString(),
      }));
      for (let i = 0; i < snapRows.length; i += 500) {
        const chunk = snapRows.slice(i, i + 500);
        const { error } = await svc.from("market_breakout_snapshots")
          .upsert(chunk, { onConflict: "symbol,exchange,trade_date" });
        if (!error) tracking.snapshots += chunk.length;
      }

      // 2. Load open episodes (active/extended/cooled) and re-evaluate each.
      const openEps: any[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await svc.from("market_breakout_tracker")
          .select("*").in("status", ["active", "extended", "cooled"])
          .range(from, from + 999);
        if (error) break;
        openEps.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      const openKeys = new Set(openEps.map((e) => `${e.symbol}|${e.exchange}`));

      const epUpdates: any[] = [];
      for (const e of openEps) {
        const key = `${e.symbol}|${e.exchange}`;
        const now = scoredByKey.get(key);
        if (!now || now.close == null) continue; // no data today — leave untouched
        const alreadyToday = e.last_evaluated_date === today;
        const entry = Number(e.entry_close) || now.close;
        const prevDays = alreadyToday ? Math.max(0, (e.days_tracked ?? 1) - 1) : (e.days_tracked ?? 1);
        const prevBelow = alreadyToday ? e.below_threshold_days ?? 0 : e.below_threshold_days ?? 0;

        const tick = nextEpisodeStatus({
          status: e.status as BreakoutStatus,
          entryClose: entry, close: now.close, score: now.breakout,
          daysTracked: prevDays, belowThresholdDays: prevBelow,
        });
        const peakClose = Math.max(Number(e.peak_close) || entry, now.close);
        const peakRet = entry > 0 ? ((peakClose - entry) / entry) * 100 : 0;
        const daysTracked = alreadyToday ? (e.days_tracked ?? 1) : (e.days_tracked ?? 1) + 1;
        const baseTrend: number[] = Array.isArray(e.score_trend) ? e.score_trend : [];
        const scoreTrend = alreadyToday ? baseTrend : [...baseTrend, now.breakout].slice(-SCORE_TREND_CAP);
        const ft = breakoutFollowThroughScore({
          entryClose: entry, currentClose: now.close, peakClose,
          daysTracked, belowThresholdDays: tick.belowThresholdDays,
          scoreTrend, lastScore: now.breakout,
        });
        const terminal = tick.status === "failed" || tick.status === "closed";

        epUpdates.push({
          symbol: e.symbol, exchange: e.exchange, first_detected_date: e.first_detected_date,
          entry_close: entry, detected_score: e.detected_score,
          peak_close: peakClose, peak_return_pct: Math.round(peakRet * 100) / 100,
          current_close: now.close, current_return_pct: Math.round(tick.returnPct * 100) / 100,
          days_tracked: daysTracked, last_score: now.breakout,
          followthrough_score: ft.score, score_trend: scoreTrend,
          status: tick.status, below_threshold_days: tick.belowThresholdDays,
          sector: now.sector, market_cap: now.market_cap,
          last_evaluated_date: today,
          closed_at: terminal ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        });
        if (tick.status === "failed") tracking.failed++;
        else if (tick.status === "closed") tracking.closed++;
        else tracking.updated_ep++;
      }
      for (let i = 0; i < epUpdates.length; i += 500) {
        const chunk = epUpdates.slice(i, i + 500);
        await svc.from("market_breakout_tracker")
          .upsert(chunk, { onConflict: "symbol,exchange,first_detected_date" });
      }

      // 3. Open fresh episodes for today's qualifiers with no open episode.
      const newEps = qualifiers
        .filter((x) => !openKeys.has(`${x.symbol}|${x.exchange}`))
        .map((x) => ({
          symbol: x.symbol, exchange: x.exchange, first_detected_date: today,
          entry_close: x.close, detected_score: x.breakout,
          peak_close: x.close, peak_return_pct: 0,
          current_close: x.close, current_return_pct: 0,
          days_tracked: 1, last_score: x.breakout,
          followthrough_score: 50, score_trend: [x.breakout],
          status: "active", below_threshold_days: 0,
          sector: x.sector, market_cap: x.market_cap,
          last_evaluated_date: today,
          updated_at: new Date().toISOString(),
        }));
      for (let i = 0; i < newEps.length; i += 500) {
        const chunk = newEps.slice(i, i + 500);
        // ignoreDuplicates: a symbol that already has today's episode (rare
        // same-day re-run) isn't reset to a fresh entry.
        const { error } = await svc.from("market_breakout_tracker")
          .upsert(chunk, { onConflict: "symbol,exchange,first_detected_date", ignoreDuplicates: true });
        if (!error) tracking.opened += chunk.length;
      }
    } catch (e) {
      // Tracking is additive — never let it fail the whole aggregates run.
      await svc.from("market_provider_health").insert({
        provider: "aggregates", endpoint: "breakout-tracking", ok: false,
        latency_ms: 0, error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
      }).then(() => {}, () => {});
    }

    return jsonResponse(req, {
      ok: true,
      trade_date: today,
      stocks: rows.length,
      breadth: { advances, declines, regime, pct_above_ema50: Math.round(pctAboveEma50) },
      sectors: sectorRows.length,
      rescored: updated,
      breakout_tracking: tracking,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
