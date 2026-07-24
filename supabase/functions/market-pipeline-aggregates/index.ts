// market-pipeline-aggregates — after the EOD pass: compute market breadth,
// sector strength ranks, relative strength vs NIFTY, then re-score every stock
// with full market context.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { istTradeDate, requireCronSecret } from "../_shared/market/cron.ts";
import { classifyRegime, breakoutScore, preBreakoutScore } from "../_shared/market/scoring.ts";
import type { IndicatorSnapshot } from "../_shared/market/indicators.ts";
import { yahooChartRetry } from "../_shared/market/yahooClient.ts";

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

    // Pull all scored rows, then join sector/is_active from market_stocks
    // in-memory (no FK between the two tables, so PostgREST embeds fail).
    const stockMeta = new Map<string, { sector: string | null; is_active: boolean }>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await svc.from("market_stocks")
        .select("symbol,exchange,sector,is_active")
        .range(from, from + 999);
      if (error) return errorResponse(req, error.message, 500);
      for (const d of data ?? []) {
        stockMeta.set(`${d.symbol}|${d.exchange}`, { sector: d.sector ?? null, is_active: !!d.is_active });
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
        rows.push({ ...d, sector: d.sector ?? meta.sector ?? null });
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

    // NIFTY context (also used for relative strength)
    let niftyClose: number | null = null;
    let niftyChangePct: number | null = null;
    let niftyReturn55: number | null = null;
    try {
      const nifty = await yahooChartRetry("^NSEI", "6mo", "1d");
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
        const nowIso = new Date().toISOString();
        const { error } = await svc.from("market_stock_scores").update({
          sector_strength: Math.round(sectorStrength * 100) / 100,
          rel_strength_nifty: relStrength != null ? Math.round(relStrength * 100) / 100 : null,
          rs_percentile: rsPercentile,
          breakout_score: bs.score,
          prebreakout_score: ps.score,
          score_components: scoreComponents,
          computed_at: nowIso,
        }).eq("symbol", r.symbol).eq("exchange", r.exchange);
        if (!error) updated++;
      }));
    }

    return jsonResponse(req, {
      ok: true,
      trade_date: today,
      stocks: rows.length,
      breadth: { advances, declines, regime, pct_above_ema50: Math.round(pctAboveEma50) },
      sectors: sectorRows.length,
      rescored: updated,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
