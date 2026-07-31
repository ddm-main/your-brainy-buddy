// market-pipeline-aggregates — after the EOD pass: compute market breadth,
// sector strength ranks, relative strength vs NIFTY, then re-score every stock
// with full market context.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { istTradeDate, requireCronSecret } from "../_shared/market/cron.ts";
import {
  classifyRegime, breakoutScore, preBreakoutScore,
  evaluateLiquidity, swingScore, intradayScore,
  BREAKOUT_QUALIFY_SCORE, SCORE_TREND_CAP,
  breakoutFollowThroughScore, nextEpisodeStatus, scoreDistribution,
  breakoutScoreV4, percentileBandCuts,
  SCORE_BAND_STRONG, SCORE_BAND_MODERATE, SCORE_BAND_WEAK,
  V4_WEIGHTS,
  type AdvancedSignals, type BreakoutStatus, type BreakoutPatterns,
  type V4Fundamentals, type V4Sentiment,
} from "../_shared/market/scoring.ts";
import type { IndicatorSnapshot, WeeklySnapshot } from "../_shared/market/indicators.ts";
import { yahooChartRetry } from "../_shared/market/yahooClient.ts";
import { getServiceProvider } from "../_shared/market/provider.ts";

// Rebuild the scorer's input from a market_stock_scores row (joined with stocks).
// Invert the v4 renormalisation back to the raw 0..1 value each bucket carried,
// and record the adjustments applied after the buckets (penalties, regime and
// fundamental multipliers, event cap). With these stored, re-weighting a
// snapshot under different bucket weights reproduces the live score exactly
// instead of comparing pre-penalty numbers against post-penalty thresholds.
function rawV4Detail(v4: {
  buckets: Record<string, number>;
  coverage: Record<string, number>;
  components: Record<string, number>;
  penalties: Record<string, number>;
  rawBeforePenalty: number | null;
  score: number | null;
}): Record<string, unknown> {
  const coverShare = Number(v4.components?.coverage_share ?? 0);
  const scale = coverShare > 0 ? 1 / coverShare : 1;
  const raw: Record<string, number> = {};
  for (const [name, w] of Object.entries(V4_WEIGHTS)) {
    const pts = Number(v4.buckets?.[name] ?? 0);
    const eff = w * scale;
    raw[name] = eff > 0 ? Math.round(Math.max(0, Math.min(1, pts / eff)) * 1000) / 1000 : 0;
  }
  const penaltyTotal = Object.values(v4.penalties ?? {})
    .reduce((a, b) => a + Number(b ?? 0), 0);
  return {
    raw,
    penalty_total: Math.round(penaltyTotal * 10) / 10,
    penalties: v4.penalties ?? {},
    regime_mult: Number(v4.components?.regime_mult ?? 1),
    fund_mult: Number(v4.components?.fundamental_mult ?? 1),
    coverage_share: coverShare,
    raw_before_penalty: v4.rawBeforePenalty,
    score: v4.score,
  };
}

// v2 fix: `atrContracting` and `macdHistRising` used to be read from yesterday's
// `score_components`, which is circular (score → components → tomorrow's score).
// v4 fix: they were then *proxied* here (`bb_width < 0.06`, `macd_hist > 0`),
// which is not the same measurement — "positive" is not "rising", and BB width
// is not ATR compression. market-pipeline-eod now persists the real booleans
// (it holds the series); read those and only fall back to the proxy when the
// row predates the migration.
function snapFromRow(r: any): IndicatorSnapshot {
  const bbw = typeof r.bb_width === "number" ? r.bb_width : null;
  const atrContracting = typeof r.atr_contracting === "boolean"
    ? r.atr_contracting
    : (bbw != null ? bbw < 0.06 : false);
  // null (not false) when the row has no stored flag: "we can't tell" must not
  // read as "not rising", which silently docked 40% of the MACD factor. The
  // macd_hist > 0 proxy is only a last resort for pre-migration rows.
  const macdHistRising: boolean | null = typeof r.macd_hist_rising === "boolean"
    ? r.macd_hist_rising
    : (typeof r.macd_hist === "number" ? r.macd_hist > 0 : null);
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
    // Without these the "don't credit support defence off a lookback low" rule
    // is inert in the pass that produces the published score.
    supportFallback: r.support_fallback ?? undefined,
    resistanceFallback: r.resistance_fallback ?? undefined,
    resistanceAbove: r.resistance_above ?? null,
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
    // Explicit state: without it the freshness factor reads `undefined` and its
    // weight is renormalised away, and `failed_breakout` can never fire.
    breakoutStateKind: r.breakout_state ?? null,
    // Age of that state. Falls back to the freshness column for pre-migration
    // rows, which is correct for a live breakout and null for a failed one.
    breakoutStateDays: r.breakout_state_days ?? r.breakout_freshness_days ?? null,
    breakoutLevelCleared: r.breakout_level_cleared ?? null,
    rollingHigh20Touches: r.rolling_high_20_touches ?? null,
    rollingHigh20TouchQuality: r.rolling_high_20_touch_quality != null
      ? Number(r.rolling_high_20_touch_quality)
      : null,
    // Persisted by market-pipeline-eod (which has the candles); without these
    // the refinement pass would silently re-score on a weaker pivot.
    pivotLevel: r.pivot_level ?? null,
    pivotTouches: r.pivot_touches ?? null,
    pivotTouchQuality: r.pivot_touch_quality != null ? Number(r.pivot_touch_quality) : null,
    relVolumeMedian30: r.rel_volume_median30 != null ? Number(r.rel_volume_median30) : null,
    barsAvailable: r.bars_available != null ? Number(r.bars_available) : null,
    volDryUpRatio: r.vol_dryup_ratio ?? null,
    volDryUpRatioBase: r.vol_dryup_ratio_base ?? null,
    emaCross2050FreshDays: r.ema_cross_20_50_days ?? null,
    emaCross50200FreshDays: r.ema_cross_50_200_days ?? null,

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
    barsW: r.weekly_bars != null ? Number(r.weekly_bars) : 0,
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

// The full pattern set the breakout scorer understands. The refinement pass
// used to call breakoutScore(snap, ctx) with no patterns at all, silently
// deleting the +8 bonus / −5 bearish penalty the EOD pass had applied.
function patternsFromRow(r: any): BreakoutPatterns | undefined {
  const p = r.pattern_flags;
  if (!p || typeof p !== "object") return undefined;
  return {
    bullishEngulfing: !!p.bullish_engulfing,
    bearishEngulfing: !!p.bearish_engulfing,
    hammer: !!p.hammer,
    shootingStar: !!p.shooting_star,
    doji: !!p.doji,
    cupAndHandle: !!p.cup_and_handle,
    cupAndHandleTriggered: !!p.cup_and_handle_triggered,
    flag: !!p.flag,
    ascendingTriangle: !!p.ascending_triangle,
    doubleBottom: !!p.double_bottom,
    inverseHeadShoulders: !!p.inverse_head_shoulders,
    fallingWedge: !!p.falling_wedge,
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

    // Only the latest session may feed breadth/sector/RS aggregates and the
    // breakout tracker. Symbols whose EOD sync failed keep an older
    // trade_date; including them would mix stale closes into today's numbers
    // and open tracker episodes dated today with a stale entry price.
    let latestTradeDate: string | null = null;
    for (const r of rows) {
      const td = typeof r.trade_date === "string" ? r.trade_date : null;
      if (td && (latestTradeDate == null || td > latestTradeDate)) latestTradeDate = td;
    }
    const totalRows = rows.length;
    const freshRows = latestTradeDate ? rows.filter((r) => r.trade_date === latestTradeDate) : rows;
    const staleSkipped = totalRows - freshRows.length;
    rows.length = 0;
    rows.push(...freshRows);
    if (rows.length === 0) return jsonResponse(req, { ok: true, note: "no rows for the latest trade date", stale_skipped: staleSkipped });

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
    // Ranking sectors by ONE day's average change is noise: a single gap-up in
    // a heavy name reorders the whole table overnight. Rank instead on a
    // blended 5D/21D return with a participation term (how much of the sector
    // is above its 50 EMA, and whether that share is rising vs yesterday).
    const prevParticipation = new Map<string, number>();
    {
      const { data } = await svc.from("market_sector_strength_daily")
        .select("sector,pct_above_ema50,trade_date")
        .lt("trade_date", today)
        .order("trade_date", { ascending: false })
        .limit(200);
      for (const d of data ?? []) {
        if (d.sector && !prevParticipation.has(d.sector) && d.pct_above_ema50 != null) {
          prevParticipation.set(d.sector, Number(d.pct_above_ema50));
        }
      }
    }
    const bySector = new Map<string, any[]>();
    for (const r of rows) {
      const sec = r.sector || "Unknown";
      if (!bySector.has(sec)) bySector.set(sec, []);
      bySector.get(sec)!.push(r);
    }
    const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    const sectorStats = [...bySector.entries()].map(([sector, list]) => {
      const chg = list.map((r) => r.change_pct).filter((v): v is number => v != null);
      const rsis = list.map((r) => r.rsi14).filter((v): v is number => v != null);
      const above50 = list.filter((r) => r.ema50 != null && r.close != null && r.close > r.ema50).length;
      const r5 = mean(list.map((r) => r.ret_5d).filter((v): v is number => v != null));
      const r21 = mean(list.map((r) => r.ret_21d).filter((v): v is number => v != null));
      const participation = (above50 / list.length) * 100;
      const prev = prevParticipation.get(sector);
      const participationDelta = prev != null ? participation - prev : null;
      // 5D carries the near-term impulse, 21D the trend, participation says
      // whether the move is broad or two stocks doing the work.
      const blended =
        0.45 * (r5 ?? 0) +
        0.35 * ((r21 ?? 0) / 3) +
        0.15 * ((participation - 50) / 10) +
        0.05 * ((participationDelta ?? 0) / 5);
      return {
        sector,
        stock_count: list.length,
        avg_change_pct: chg.length ? chg.reduce((a, b) => a + b, 0) / chg.length : null,
        avg_rsi: rsis.length ? rsis.reduce((a, b) => a + b, 0) / rsis.length : null,
        pct_above_ema50: participation,
        avg_ret_5d: r5,
        avg_ret_21d: r21,
        participation_delta: participationDelta,
        blended_strength: Math.round(blended * 1000) / 1000,
      };
    });
    sectorStats.sort((a, b) => b.blended_strength - a.blended_strength);
    const sectorRank = new Map<string, number>();
    const sectorRows = sectorStats.map((s, i) => {
      sectorRank.set(s.sector, i + 1);
      return { ...s, trade_date: today, strength_rank: i + 1, computed_at: new Date().toISOString() };
    });
    if (sectorRows.length > 0) {
      await svc.from("market_sector_strength_daily").upsert(sectorRows, { onConflict: "trade_date,sector" });
    }
    const nSectors = sectorStats.length || 1;

    // ---- Bucket 7 & 8 inputs: fundamentals, AI verdict, news, corp actions ----
    // These three sections of the model contributed literally nothing before
    // this pass loaded them; the scorer's coverage map now records whether
    // each was actually available per symbol.
    const fundMap = new Map<string, V4Fundamentals>();
    for (let from = 0; ; from += 1000) {
      const { data } = await svc.from("market_fundamentals_global")
        .select("symbol,exchange,revenue_growth_yoy,profit_growth_yoy,roe,debt_to_equity,promoter_holding,pe_ttm")
        .range(from, from + 999);
      for (const d of data ?? []) {
        fundMap.set(`${d.symbol}|${d.exchange}`, {
          revenueGrowthYoy: d.revenue_growth_yoy != null ? Number(d.revenue_growth_yoy) : null,
          profitGrowthYoy: d.profit_growth_yoy != null ? Number(d.profit_growth_yoy) : null,
          roe: d.roe != null ? Number(d.roe) : null,
          debtToEquity: d.debt_to_equity != null ? Number(d.debt_to_equity) : null,
          promoterHolding: d.promoter_holding != null ? Number(d.promoter_holding) : null,
          peTtm: d.pe_ttm != null ? Number(d.pe_ttm) : null,
        });
      }
      if (!data || data.length < 1000) break;
    }

    // Latest AI verdict per symbol (within a week — an older one is not a view
    // on today's tape and is treated as missing, not as neutral).
    const aiMap = new Map<string, { verdict: string | null; confidence: number | null }>();
    {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const { data } = await svc.from("market_stock_ai")
        .select("symbol,exchange,recommendation,confidence,created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .limit(5000);
      for (const d of data ?? []) {
        aiMap.set(`${d.symbol}|${d.exchange}`, {
          verdict: d.recommendation ?? null,
          confidence: d.confidence != null ? Number(d.confidence) : null,
        });
      }
    }

    // News sentiment over a 7-day window (rows classified by market-news-sync).
    const newsMap = new Map<string, { sum: number; n: number }>();
    {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const { data } = await svc.from("market_news")
        .select("symbol,exchange,sentiment,published_at")
        .gte("published_at", since)
        .not("sentiment", "is", null)
        .limit(5000);
      for (const d of data ?? []) {
        if (!d.symbol) continue;
        const k = `${d.symbol}|${d.exchange ?? "NSE"}`;
        const cur = newsMap.get(k) ?? { sum: 0, n: 0 };
        cur.sum += Number(d.sentiment); cur.n += 1;
        newsMap.set(k, cur);
      }
    }

    // Nearest upcoming corporate action (ex-date) per symbol, in sessions.
    const eventMap = new Map<string, number>();
    {
      const todayIso = new Date().toISOString().slice(0, 10);
      const { data } = await svc.from("corporate_actions")
        .select("symbol,exchange,ex_date")
        .gte("ex_date", todayIso)
        .lte("ex_date", new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10))
        .limit(5000);
      for (const d of data ?? []) {
        if (!d.symbol || !d.ex_date) continue;
        const days = Math.round((Date.parse(`${d.ex_date}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
        const k = `${d.symbol}|${d.exchange ?? "NSE"}`;
        const prev = eventMap.get(k);
        if (prev == null || days < prev) eventMap.set(k, days);
      }
    }

    // ---- Relative strength: true 55-session return vs NIFTY's own ----
    // The old proxy compared (close − ema100)/ema100 against half the NIFTY
    // 55-day return: two different horizons subtracted from each other, which
    // is not relative strength at all. Use the like-for-like 55-session return
    // when the EOD pass has written one, falling back to the proxy only for
    // rows that predate that column.
    const rsOf = (r: any): number | null => {
      if (r.ret_55d != null) return Number(r.ret_55d);
      if (r.close != null && r.ema100 != null && r.ema100 !== 0) {
        return ((r.close - r.ema100) / r.ema100) * 100;
      }
      return null;
    };
    const rsInputs: { key: string; rs: number }[] = [];
    for (const r of rows) {
      const v = rsOf(r);
      if (v != null) rsInputs.push({ key: `${r.symbol}|${r.exchange}`, rs: v });
    }
    rsInputs.sort((a, b) => a.rs - b.rs);
    const rsPct = new Map<string, number>();
    const n = rsInputs.length;
    rsInputs.forEach((it, idx) => {
      rsPct.set(it.key, n > 1 ? Math.round((idx / (n - 1)) * 1000) / 10 : 50);
    });

    // ---- Market-cap tier percentiles for rel-volume and ATR% -------------
    // Small caps structurally run higher ATR% and rel-volume than large caps,
    // so absolute thresholds put micro-caps permanently at the top of the
    // list. Rank each symbol against its OWN size tier instead.
    const tierOf = (mc: number | null): string =>
      mc == null ? "unknown" : mc >= 200_000_000_000 ? "large" : mc >= 50_000_000_000 ? "mid" : "small";
    const tierRelVolPct = new Map<string, number>();
    const tierAtrPctile = new Map<string, number>();
    {
      const tiers = new Map<string, any[]>();
      for (const r of rows) {
        const t = tierOf(r.market_cap);
        if (!tiers.has(t)) tiers.set(t, []);
        tiers.get(t)!.push(r);
      }
      const rankInto = (list: any[], pick: (r: any) => number | null, out: Map<string, number>) => {
        const vals = list
          .map((r) => ({ key: `${r.symbol}|${r.exchange}`, v: pick(r) }))
          .filter((x): x is { key: string; v: number } => x.v != null)
          .sort((a, b) => a.v - b.v);
        vals.forEach((x, i) => {
          out.set(x.key, vals.length > 1 ? Math.round((i / (vals.length - 1)) * 1000) / 10 : 50);
        });
      };
      for (const list of tiers.values()) {
        rankInto(list, (r) => (r.rel_volume_median30 ?? r.rel_volume) != null
          ? Number(r.rel_volume_median30 ?? r.rel_volume) : null, tierRelVolPct);
        rankInto(list, (r) => r.atr_pct != null ? Number(r.atr_pct) : null, tierAtrPctile);
      }
    }

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
      // Pivot / prior-high the breakout cleared — recorded as the episode's
      // trigger price so day-1 follow-through is measurable (entry_close on
      // detection day is by definition a 0.00% return).
      trigger: number | null;
      v4: number | null;
      v4Buckets?: Record<string, number>;
      v4Coverage?: Record<string, number>;
      // Raw 0..1 bucket values plus the post-bucket adjustments, so the
      // Calibration Lab can re-weight a snapshot exactly the way the live
      // scorer would have — penalties and multipliers included.
      v4Raw?: Record<string, unknown>;
    }
    const scored: Scored[] = [];
    let updated = 0;
    let rescoreFailed = 0;
    let rescoreFirstError: string | null = null;
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      await Promise.all(batch.map(async (r) => {
        const rank = sectorRank.get(r.sector || "Unknown");
        // null, not 0.5, when the sector ranking is unavailable: a made-up
        // mid-grade counted as real data toward the strength bucket's coverage
        // and handed every stock 20% of that bucket for nothing.
        const sectorStrength = rank != null && nSectors > 1
          ? 1 - (rank - 1) / (nSectors - 1)
          : null;
        // Like-for-like: the stock's 55-session return minus the index's own
        // 55-session return over the same window.
        const stockRs = rsOf(r);
        const relStrength = stockRs != null && niftyReturn55 != null
          ? stockRs - niftyReturn55
          : null;
        const rsPercentile = rsPct.get(`${r.symbol}|${r.exchange}`) ?? null;
        const snap = { ...snapFromRow(r), rsPercentile };
        const key = `${r.symbol}|${r.exchange}`;
        const ctx = {
          sectorStrength, regime, relStrengthNifty: relStrength,
          deliveryPct: r.delivery_pct != null ? Number(r.delivery_pct) : null,
        };
        // Patterns MUST be passed here — omitting them stripped the pattern
        // bonus/penalty the EOD pass had already applied.
        const pats = patternsFromRow(r);
        const bs = breakoutScore(snap, ctx, pats);
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

        // ---- v4: the coverage-aware 8-bucket score ----
        const news = newsMap.get(key);
        const ai = aiMap.get(key);
        const v4 = breakoutScoreV4({
          s: snap,
          ctx,
          patterns: pats,
          weekly,
          adv,
          liquidity,
          avgTurnoverCr,
          tierRelVolumePct: tierRelVolPct.get(key) ?? null,
          tierAtrPct: tierAtrPctile.get(key) ?? null,
          barsAvailable: r.bars_available != null ? Number(r.bars_available) : null,
          fundamentals: fundMap.get(key) ?? null,
          sentiment: {
            aiVerdict: ai?.verdict ?? null,
            aiConfidence: ai?.confidence ?? null,
            newsSentiment: news && news.n > 0 ? news.sum / news.n : null,
            newsCount: news?.n ?? 0,
            eventInDays: eventMap.get(key) ?? null,
          },
        });

        const nowIso = new Date().toISOString();
        const { error } = await svc.from("market_stock_scores").update({
          sector_strength: sectorStrength == null ? null : Math.round(sectorStrength * 100) / 100,
          rel_strength_nifty: relStrength != null ? Math.round(relStrength * 100) / 100 : null,
          rs_percentile: rsPercentile,
          breakout_score: bs.score,
          prebreakout_score: ps.score,
          score_components: scoreComponents,
          breakout_score_v4: v4.score,
          breakout_v4_components: { buckets: v4.buckets, factors: v4.components, penalties: v4.penalties },
          breakout_v4_coverage: v4.coverage,
          score_unavailable_reason: v4.unavailableReason,
          is_liquid_tradable: liquidity.ok,
          liquidity_reasons: liquidity.reasons,
          swing_score: sw.score,
          swing_components: sw.components,
          intraday_score: is.score,
          intraday_components: is.components,
          context_complete: true,
          is_stale: false,
          computed_at: nowIso,
        // Scope by trade_date: without it, today's market context gets stamped
        // onto a row that still holds yesterday's bar.
        }).eq("symbol", r.symbol).eq("exchange", r.exchange).eq("trade_date", r.trade_date);
        // Never swallow this. A silent `if (!error)` here meant a single bad
        // column name failed all 2,505 updates while the run still reported
        // ok:true — the scores table simply stopped advancing with no signal
        // anywhere. Count failures and surface the first reason.
        if (!error) {
          updated++;
        } else {
          rescoreFailed++;
          if (!rescoreFirstError) {
            rescoreFirstError = [error.message, error.details, error.hint, error.code]
              .filter(Boolean).join(" | ");
          }
        }

        scored.push({
          symbol: r.symbol, exchange: r.exchange,
          close: r.close ?? null, market_cap: r.market_cap ?? null,
          sector: r.sector ?? null, rel_volume: r.rel_volume ?? null,
          breakout: bs.score, prebreakout: ps.score, swing: sw.score,
          liquidityOk: liquidity.ok, components: scoreComponents,
          trigger: snap.pivotLevel ?? snap.rollingHigh20 ?? null,
          v4: v4.score,
          v4Buckets: v4.buckets, v4Coverage: v4.coverage,
          v4Raw: rawV4Detail(v4),
        });
      }));
    }

    // ---- Relative score ranking (percentile within the tradable universe) ----
    // Absolute bands (70/55/40) are regime-dependent: in a weak tape the whole
    // universe can sit below 55 and the screener shows nothing "strong", while
    // in a hot tape everything qualifies. The rank says where a name sits
    // *today* relative to its peers, which is what a trader actually acts on.
    // Only liquid names are ranked — illiquid junk shouldn't dilute the scale.
    let ranked = 0;
    try {
      const rankOf = (key: "breakout" | "swing") => {
        const pool = scored.filter((x) => x.liquidityOk).map((x) => ({ k: `${x.symbol}|${x.exchange}`, v: x[key] }));
        pool.sort((a, b) => a.v - b.v);
        const m = new Map<string, number>();
        const n = pool.length;
        pool.forEach((it, i) => m.set(it.k, n > 1 ? Math.round((i / (n - 1)) * 1000) / 10 : 50));
        return m;
      };
      const boRank = rankOf("breakout");
      const swRank = rankOf("swing");
      const v4Pool = scored.filter((x) => x.liquidityOk && x.v4 != null)
        .map((x) => ({ k: `${x.symbol}|${x.exchange}`, v: x.v4 as number }));
      v4Pool.sort((a, b) => a.v - b.v);
      const v4Rank = new Map<string, number>();
      v4Pool.forEach((it, i) => v4Rank.set(it.k, v4Pool.length > 1 ? Math.round((i / (v4Pool.length - 1)) * 1000) / 10 : 50));
      for (let i = 0; i < scored.length; i += 50) {
        const batch = scored.slice(i, i + 50);
        await Promise.all(batch.map(async (x) => {
          const k = `${x.symbol}|${x.exchange}`;
          const { error } = await svc.from("market_stock_scores").update({
            breakout_rank_pct: boRank.get(k) ?? null,
            swing_rank_pct: swRank.get(k) ?? null,
            breakout_v4_rank_pct: v4Rank.get(k) ?? null,
          }).eq("symbol", x.symbol).eq("exchange", x.exchange);
          if (!error) ranked++;
        }));
      }
    } catch { /* ranking is additive — never fail the run */ }

    // ---- Stale marking + daily calibration ---------------------------------
    // Any scored row that is not on the latest session is stale by definition:
    // flag it so the UI can grey it instead of presenting it as today's read.
    let staleFlagged = 0;
    if (latestTradeDate) {
      // `select(cols, opts)` on an update builder is valid at runtime but the
      // Deno-resolved supabase-js overloads only see the 1-arg form.
      const { count } = await (svc.from("market_stock_scores")
        .update({ is_stale: true })
        .lt("trade_date", latestTradeDate) as any)
        .select("symbol", { count: "exact", head: true });
      staleFlagged = count ?? 0;
    }

    // Persist the day's v4 distribution + percentile-anchored band cut-offs so
    // "STRONG" means the same thing in a weak tape and a hot one.
    let calibration: Record<string, unknown> | null = null;
    try {
      const v4Scores = scored.filter((x) => x.liquidityOk && x.v4 != null).map((x) => x.v4 as number);
      if (v4Scores.length > 0 && latestTradeDate) {
        const dist = scoreDistribution(v4Scores);
        const cuts = percentileBandCuts(v4Scores);
        calibration = { ...dist, ...cuts };
        await svc.from("market_score_distribution").upsert({
          trade_date: latestTradeDate,
          model: "breakout_v4",
          n: dist.n,
          p50: dist.p50, p70: dist.p70, p90: dist.p90, max: dist.max,
          strong_cut: cuts.strong, moderate_cut: cuts.moderate, watch_cut: cuts.watch,
          updated_at: new Date().toISOString(),
        }, { onConflict: "trade_date,model" });
      }
    } catch { /* calibration is additive — never fail the run */ }

    // ---- Score history + forward hit-rate feedback -------------------------
    // Without a record of what was claimed and what happened next, the weights
    // are an opinion. Snapshot every scored symbol daily, then fill in the
    // realised 5/10/21-session returns as those sessions arrive, so band
    // performance (does 70+ actually beat 40-54?) becomes measurable and
    // Phase 4 calibration can be fitted rather than guessed.
    const history = { written: 0, evaluated: 0 };
    try {
      if (latestTradeDate) {
        const bandOf = (v: number) =>
          v >= SCORE_BAND_STRONG ? "strong"
          : v >= SCORE_BAND_MODERATE ? "moderate"
          : v >= SCORE_BAND_WEAK ? "watch" : "weak";
        // Percentile of the v4 score within the liquid universe, so a snapshot
        // can be read back relative to the tape it was taken in.
        const v4RankPool = scored.filter((x) => x.liquidityOk && x.v4 != null)
          .map((x) => ({ k: `${x.symbol}|${x.exchange}`, v: x.v4 as number }))
          .sort((a, b) => a.v - b.v);
        const histRank = new Map<string, number>();
        v4RankPool.forEach((it, i) =>
          histRank.set(it.k, v4RankPool.length > 1 ? Math.round((i / (v4RankPool.length - 1)) * 1000) / 10 : 50));

        const histRows = scored
          .filter((x) => x.v4 != null)
          .map((x) => ({
            symbol: x.symbol, exchange: x.exchange,
            trade_date: latestTradeDate, model: "breakout_v4",
            score: x.v4, band: bandOf(x.v4 as number),
            rank_pct: histRank.get(`${x.symbol}|${x.exchange}`) ?? null,
            close: x.close, buckets: x.v4Buckets ?? null, coverage: x.v4Coverage ?? null,
            // Raw bucket values + penalty/multiplier detail: lets the optimizer
            // re-weight this snapshot into a *comparable* post-penalty score.
            raw_buckets: x.v4Raw ?? null,
            // Stamped here or the calibration fit silently drops every live row.
            is_liquid_tradable: x.liquidityOk,
            // This pass runs with full market context (regime, sector strength).
            context_neutral: false,
          }));
        for (let i = 0; i < histRows.length; i += 500) {
          const { error } = await svc.from("market_score_history")
            .upsert(histRows.slice(i, i + 500), { onConflict: "symbol,exchange,trade_date,model" });
          if (!error) history.written += Math.min(500, histRows.length - i);
        }

        // Forward returns, calibration and the band distribution are NOT
        // computed here any more. The old inline loop wrote *today's* return
        // into fwd_ret_5d/10d/21d alike (a 40-session-old snapshot got its
        // 40-day return stamped as its "5-day" return) and used unadjusted
        // closes, which corrupted every band statistic. market-score-evaluate
        // owns that now via evaluate_score_history_forward() /
        // fit_score_calibration() / refresh_score_distribution().
      }
    } catch { /* feedback loop is additive — never fail the run */ }



    // ---- Breakout tracking: daily snapshot + multi-day episode maintenance ----
    // Re-checks every open episode (yesterday's picks) and opens fresh episodes
    // for today's new qualifiers, so a stock flagged earlier keeps being
    // followed forward alongside the day's new breakouts. Idempotent per day:
    // re-runs on the same trade_date refresh values without double-counting
    // days_tracked or re-appending the score trend.
    const tracking = { snapshots: 0, opened: 0, updated_ep: 0, failed: 0, closed: 0 };
    // Write failures inside the tracking block used to vanish entirely: the
    // whole phase shared one catch and the per-chunk errors were dropped, so a
    // broken column silently stopped the tracker while the run reported ok.
    const trackingErrors: string[] = [];
    try {

      // The tracker follows the SAME model the UI, the score-explain page and
      // the Calibration Lab use: v4. It used to open and tick episodes on the
      // legacy `breakoutScore` while displaying v4 next to it, so "Health" and
      // "Score" described two different models and the explain link opened a
      // number the episode was never based on. Legacy is still recorded, as a
      // secondary column, for continuity of the older episodes.
      const v4Of = (x: Scored): number | null => (x.v4 == null ? null : x.v4);
      const qualifiers = scored.filter(
        (x) => x.close != null && x.liquidityOk && (v4Of(x) ?? 0) >= BREAKOUT_QUALIFY_SCORE,
      );
      // Snapshot near-misses too (>= 60): a name that approaches the threshold
      // for days before breaking out otherwise leaves no run-up history, and
      // the calibration sample is artificially truncated at the qualify line.
      const SNAPSHOT_MIN_SCORE = 60;
      const snapshotSet = scored.filter(
        (x) => x.close != null && x.liquidityOk && (v4Of(x) ?? 0) >= SNAPSHOT_MIN_SCORE,
      );
      const scoredByKey = new Map(scored.map((x) => [`${x.symbol}|${x.exchange}`, x]));

      // Rank of each score inside today's liquid universe. "82" means nothing
      // on a day when 400 names clear 80; the percentile does.
      const rankPool = scored.filter((x) => x.liquidityOk && x.v4 != null)
        .map((x) => ({ k: `${x.symbol}|${x.exchange}`, v: x.v4 as number }))
        .sort((a, b) => a.v - b.v);
      const rankPct = new Map<string, number>();
      rankPool.forEach((it, i) => rankPct.set(
        it.k, rankPool.length > 1 ? Math.round((i / (rankPool.length - 1)) * 1000) / 10 : 50));

      // Trading sessions, newest first — taken from the pipeline's own daily
      // distribution row so "days tracked" counts sessions, not calendar days,
      // and a skipped session leaves a visible gap in the score trend.
      const sessions: string[] = await (async () => {
        const { data } = await svc.from("market_score_distribution")
          .select("trade_date").eq("model", "breakout_v4")
          .order("trade_date", { ascending: false }).limit(120);
        const list = (data ?? []).map((d: any) => String(d.trade_date));
        if (!list.includes(today)) list.unshift(today);
        return list;
      })();
      const sessionIdx = new Map(sessions.map((d, i) => [d, i]));
      // Sessions strictly between `from` and today (0 when consecutive).
      const sessionsSince = (from: string | null): number | null => {
        if (!from) return null;
        const a = sessionIdx.get(from);
        const b = sessionIdx.get(today);
        if (a == null || b == null) return null;
        return Math.max(0, a - b);
      };

      // 1. Snapshot today's qualifiers (per-symbol daily score history).
      const snapRows = snapshotSet.map((x) => ({
        symbol: x.symbol, exchange: x.exchange, trade_date: today,
        // breakout_score carries the v4 score (the tracked model); the legacy
        // score stays available through market_stock_scores.
        breakout_score: v4Of(x) ?? x.breakout, prebreakout_score: x.prebreakout, swing_score: x.swing,
        close: x.close, market_cap: x.market_cap, sector: x.sector,
        rel_volume: x.rel_volume, regime, components: x.components,
        computed_at: new Date().toISOString(),
      }));
      for (let i = 0; i < snapRows.length; i += 500) {
        const chunk = snapRows.slice(i, i + 500);
        const { error } = await svc.from("market_breakout_snapshots")
          .upsert(chunk, { onConflict: "symbol,exchange,trade_date" });
        if (!error) tracking.snapshots += chunk.length;
        else trackingErrors.push(`snapshot: ${error.message}`);
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

      // Today's actual bar extremes for the tracked names, so the episode
      // records the worst drawdown it put you through (MAE) and the best price
      // it printed — not just where it happened to close.
      const barBySymbol = new Map<string, { high: number | null; low: number | null }>();
      {
        const watched = Array.from(new Set([
          ...openEps.map((e) => String(e.symbol)),
          ...qualifiers.map((x) => x.symbol),
        ]));
        for (let i = 0; i < watched.length; i += 300) {
          const { data } = await svc.from("market_daily_prices")
            .select("symbol,exchange,high,low")
            .eq("trade_date", today)
            .in("symbol", watched.slice(i, i + 300));
          for (const d of data ?? []) {
            barBySymbol.set(`${d.symbol}|${d.exchange}`, {
              high: d.high == null ? null : Number(d.high),
              low: d.low == null ? null : Number(d.low),
            });
          }
        }
      }

      const epUpdates: any[] = [];
      for (const e of openEps) {
        const key = `${e.symbol}|${e.exchange}`;
        const now = scoredByKey.get(key);
        if (!now || now.close == null) continue; // no data today — leave untouched
        const nowScore = v4Of(now) ?? now.breakout;
        const alreadyToday = e.last_evaluated_date === today;
        // Entry price correction: an episode opened earlier *today* may have
        // been stamped from a partial intraday close. While it is still the
        // same session the entry is provisional, so re-read it — every return,
        // MAE and follow-through number downstream is measured off this price,
        // and a stale intraday entry poisons all of them for the episode's
        // whole life. From the next session onward entry is immutable history.
        const openedToday = e.first_detected_date === today;
        const entry = openedToday ? now.close : (Number(e.entry_close) || now.close);
        const prevDays = alreadyToday ? Math.max(0, (e.days_tracked ?? 1) - 1) : (e.days_tracked ?? 1);

        // A re-run on the same session must not count as another session. The
        // stored counter already includes today's increment, so reverse it
        // before ticking again — without this an intraday re-run marched the
        // counter up until the episode cooled on its own re-runs (observed
        // live: below_threshold_days = 5 on a 2-session-old episode).
        const storedBelow = e.below_threshold_days ?? 0;
        const countedTodayBelow = alreadyToday && (Number(e.last_score) || 0) < BREAKOUT_QUALIFY_SCORE;
        const prevBelow = countedTodayBelow ? Math.max(0, storedBelow - 1) : storedBelow;

        const tick = nextEpisodeStatus({
          status: e.status as BreakoutStatus,
          entryClose: entry, close: now.close, score: nowScore,
          daysTracked: prevDays, belowThresholdDays: prevBelow,
        });
        const bar = barBySymbol.get(key);
        // Peak and trough measure what happened *after* entry. Seeding them at
        // the entry price made peak return unable to go negative, so a name
        // that only ever fell still reported "Peak +0.00%" — a number that
        // implies it traded back to entry when it never did.
        const prevPeak = e.peak_close == null ? null : Number(e.peak_close);
        const peakClose = prevPeak == null ? now.close : Math.max(prevPeak, now.close);
        const prevPeakHigh = e.peak_high == null ? null : Number(e.peak_high);
        const todayHigh = bar?.high ?? now.close;
        const peakHigh = Math.max(prevPeakHigh ?? todayHigh, todayHigh, peakClose);
        const prevTrough = e.trough_low == null ? null : Number(e.trough_low);
        const todayLow = bar?.low ?? now.close;
        const troughLow = Math.min(prevTrough ?? todayLow, todayLow);
        const maePct = entry > 0 ? ((troughLow - entry) / entry) * 100 : 0;
        const peakRet = entry > 0 ? ((peakClose - entry) / entry) * 100 : 0;
        // Sessions, not rows: a re-run on the same day must not advance it, and
        // a skipped session must not compress the timeline.
        const elapsed = sessionsSince(e.first_detected_date);
        const daysTracked = elapsed != null
          ? elapsed + 1
          : (alreadyToday ? (e.days_tracked ?? 1) : (e.days_tracked ?? 1) + 1);
        const baseTrend: number[] = Array.isArray(e.score_trend) ? e.score_trend : [];
        // Missed sessions become explicit nulls so the sparkline shows a gap
        // instead of silently stitching two distant sessions together.
        const gap = alreadyToday ? 0 : Math.max(0, (sessionsSince(e.last_evaluated_date) ?? 1) - 1);
        // On a same-day re-run the trend must be corrected in place, not left
        // alone: skipping the append froze the last point at the earlier
        // intraday score while last_score moved on.
        const scoreTrend = alreadyToday
          ? (baseTrend.length ? [...baseTrend.slice(0, -1), nowScore] : [nowScore])
          : [...baseTrend, ...Array(Math.min(gap, SCORE_TREND_CAP)).fill(null), nowScore]
              .slice(-SCORE_TREND_CAP);
        // Heals rows already inflated by the re-run bug: you cannot have been
        // below the threshold on more sessions than you have been tracked.
        const belowDays = Math.min(tick.belowThresholdDays, daysTracked);
        const ft = breakoutFollowThroughScore({
          entryClose: entry, currentClose: now.close, peakClose,
          daysTracked, belowThresholdDays: belowDays,
          scoreTrend: scoreTrend.filter((v): v is number => typeof v === "number"),
          lastScore: nowScore,
        });
        const terminal = tick.status === "failed" || tick.status === "closed";

        epUpdates.push({
          symbol: e.symbol, exchange: e.exchange, first_detected_date: e.first_detected_date,
          entry_close: entry, trigger_price: e.trigger_price ?? null,
          detected_score: e.detected_score,
          detected_score_legacy: e.detected_score_legacy ?? null,
          last_score_legacy: now.breakout,
          rank_pct: rankPct.get(key) ?? null,
          peak_close: peakClose, peak_return_pct: Math.round(peakRet * 100) / 100,
          peak_high: Math.round(peakHigh * 100) / 100,
          trough_low: Math.round(troughLow * 100) / 100,
          mae_pct: Math.round(maePct * 100) / 100,
          sessions_elapsed: elapsed,
          current_close: now.close, current_return_pct: Math.round(tick.returnPct * 100) / 100,
          days_tracked: daysTracked, last_score: nowScore,
          followthrough_score: ft.score, score_trend: scoreTrend,
          status: tick.status, below_threshold_days: belowDays,
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
        const { error } = await svc.from("market_breakout_tracker")
          .upsert(chunk, { onConflict: "symbol,exchange,first_detected_date" });
        // Silently discarding this meant episodes stopped advancing while the
        // run still reported a healthy tracking block.
        if (error) trackingErrors.push(`tick: ${error.message}`);
      }


      // 3. Open fresh episodes for today's qualifiers with no open episode.
      // Cooldown: a name that just failed shouldn't reopen the next session on
      // the same tape — require 3 clear sessions after a terminal episode.
      const REOPEN_COOLDOWN_SESSIONS = 3;
      const blockedUntilSession = new Map<string, number>();
      {
        const since = sessions[Math.min(sessions.length - 1, 10)] ?? today;
        const { data } = await svc.from("market_breakout_tracker")
          .select("symbol,exchange,last_evaluated_date,status")
          .in("status", ["failed", "closed"])
          .gte("last_evaluated_date", since);
        for (const d of data ?? []) {
          const gapSessions = sessionsSince(String(d.last_evaluated_date));
          if (gapSessions != null && gapSessions < REOPEN_COOLDOWN_SESSIONS) {
            blockedUntilSession.set(`${d.symbol}|${d.exchange}`, gapSessions);
          }
        }
      }
      const newEps = qualifiers
        .filter((x) => {
          const k = `${x.symbol}|${x.exchange}`;
          return !openKeys.has(k) && !blockedUntilSession.has(k);
        })
        .map((x) => ({
          symbol: x.symbol, exchange: x.exchange, first_detected_date: today,
          entry_close: x.close, trigger_price: x.trigger,
          detected_score: v4Of(x) ?? x.breakout,
          detected_score_legacy: x.breakout,
          last_score_legacy: x.breakout,
          rank_pct: rankPct.get(`${x.symbol}|${x.exchange}`) ?? null,
          // Peak is the best close *after* entry. On day 1 there is no such
          // close yet, so it stays unknown instead of being pinned to entry
          // (which is what made peak return unable to print a negative).
          peak_close: null, peak_return_pct: null,
          // Nothing has happened after entry yet — peak/trough/MAE are unknown,
          // not zero. Zero here is what made day-1 rows look measured.
          peak_high: null, trough_low: null,
          mae_pct: null, sessions_elapsed: 0,
          current_close: x.close, current_return_pct: 0,
          days_tracked: 1, last_score: v4Of(x) ?? x.breakout,
          followthrough_score: null, score_trend: [v4Of(x) ?? x.breakout],
          status: "active", below_threshold_days: 0,
          sector: x.sector, market_cap: x.market_cap,
          last_evaluated_date: today,
          updated_at: new Date().toISOString(),
        }));
      for (let i = 0; i < newEps.length; i += 500) {
        const chunk = newEps.slice(i, i + 500);
        // ignoreDuplicates: a symbol that already has today's episode (rare
        // same-day re-run) isn't reset to a fresh entry. Entry-price
        // corrections for an episode opened earlier today are handled in
        // phase 2, which re-reads the close — so nothing is frozen by this.
        const { error } = await svc.from("market_breakout_tracker")
          .upsert(chunk, { onConflict: "symbol,exchange,first_detected_date", ignoreDuplicates: true });
        if (!error) tracking.opened += chunk.length;
        else trackingErrors.push(`open: ${error.message}`);
      }

    } catch (e) {
      // Tracking is additive — never let it fail the whole aggregates run.
      trackingErrors.push(e instanceof Error ? e.message : String(e));
    }
    if (trackingErrors.length) {
      await svc.from("market_provider_health").insert({
        provider: "aggregates", endpoint: "breakout-tracking", ok: false,
        latency_ms: 0, error: trackingErrors.join(" | ").slice(0, 500),
      }).then(() => {}, () => {});

    }

    // ---- Threshold calibration telemetry ----
    // Record where today's universe actually sits versus the fixed 70/55/40
    // bands, so the bands can be judged against the live distribution instead
    // of assumed. Never allowed to fail the run.
    const dist = scoreDistribution(scored.filter((x) => x.liquidityOk).map((x) => x.breakout));
    try {
      const calRows = [
        ["breakout_p50", dist.p50], ["breakout_p70", dist.p70], ["breakout_p90", dist.p90],
        ["breakout_max", dist.max],
        ["breakout_pct_above_strong", dist.pct_at_or_above_strong],
        ["breakout_pct_above_moderate", dist.pct_at_or_above_moderate],
      ].filter(([, v]) => v != null).map(([component, weight]) => ({
        model_version: `breakout_v2:${today}`,
        component: component as string,
        weight: Number(weight),
        sample_n: dist.n,
      }));
      if (calRows.length) await svc.from("market_scoring_calibration").insert(calRows);
    } catch { /* telemetry only */ }

    return jsonResponse(req, {
      ok: true,
      trade_date: today,
      stocks: rows.length,
      latest_trade_date: latestTradeDate,
      stale_skipped: staleSkipped,
      breadth: { advances, declines, regime, pct_above_ema50: Math.round(pctAboveEma50) },
      sectors: sectorRows.length,
      rescored: updated,
      rescore_failed: rescoreFailed,
      ranked,
      rescore_error: rescoreFirstError,
      breakout_tracking: tracking,
      breakout_tracking_errors: trackingErrors.slice(0, 5),

      score_distribution: dist,
      stale_flagged: staleFlagged,
      v4_calibration: calibration,
      score_history: history,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
