// market-pipeline-aggregates — after the EOD pass: compute market breadth,
// sector strength ranks, relative strength vs NIFTY, then re-score every stock
// with full market context.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { istTradeDate, requireCronSecret } from "../_shared/market/cron.ts";
import { classifyRegime, breakoutScore, preBreakoutScore } from "../_shared/market/scoring.ts";
import type { IndicatorSnapshot } from "../_shared/market/indicators.ts";
import { yahooChartRetry } from "../_shared/market/yahooClient.ts";

// Rebuild the scorer's input from a market_data row.
function snapFromRow(r: any): IndicatorSnapshot {
  return {
    close: r.ltp ?? 0,
    changePct: r.change_pct,
    volume: r.volume ?? 0,
    volAvg20: r.vol_avg_20,
    relVolume: r.rel_volume,
    ema20: r.ema_20,
    ema50: r.ema_50,
    ema100: r.ema_100,
    ema200: r.ema_200,
    rsi14: r.rsi,
    macd: r.macd,
    macdSignal: r.macd_signal,
    macdHist: r.macd_hist,
    adx14: r.adx,
    atr14: r.atr,
    atrPct: r.atr_pct,
    bbUpper: r.bb_upper,
    bbLower: r.bb_lower,
    bbWidth: r.bb_width,
    bbSqueeze: !!r.bb_squeeze,
    atrContracting: !!(r.score_components?.prebreakout?.atr_contraction > 0),
    high52w: r.high_52w,
    low52w: r.low_52w,
    pctFrom52wHigh: r.pct_from_52w_high,
    aboveEma200: !!r.above_ema_200,
    emaAligned: r.ema_20 != null && r.ema_50 != null && r.ema_200 != null && r.ema_20 > r.ema_50 && r.ema_50 > r.ema_200,
    higherLows: !!r.higher_lows,
    support: r.support_level,
    resistance: r.resistance_level,
    nearResistance: !!r.near_resistance,
    macdHistRising: !!(r.score_components?.breakout?.macd >= 10),
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

    // Pull all market_data rows with trade_date (paged)
    const rows: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await svc.from("market_data")
        .select("*")
        .not("trade_date", "is", null)
        .eq("is_active", true)
        .range(from, from + 999);
      if (error) return errorResponse(req, error.message, 500);
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    if (rows.length === 0) return jsonResponse(req, { ok: true, note: "no trade data yet — run market-pipeline-eod first" });

    // ---- Breadth ----
    const advances = rows.filter((r) => (r.change_pct ?? 0) > 0).length;
    const declines = rows.filter((r) => (r.change_pct ?? 0) < 0).length;
    const unchanged = rows.length - advances - declines;
    const pctAbove = (key: string) =>
      (rows.filter((r) => r[key] != null && r.ltp != null && r.ltp > r[key]).length / rows.length) * 100;
    const pctAboveEma20 = pctAbove("ema_20");
    const pctAboveEma50 = pctAbove("ema_50");
    const pctAboveEma200 = pctAbove("ema_200");
    const rsiVals = rows.map((r) => r.rsi).filter((v: number | null): v is number => v != null);
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
      const rsis = list.map((r) => r.rsi).filter((v): v is number => v != null);
      const above50 = list.filter((r) => r.ema_50 != null && r.ltp != null && r.ltp > r.ema_50).length;
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

    // ---- Final scoring with market context ----
    let updated = 0;
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      await Promise.all(batch.map(async (r) => {
        const rank = sectorRank.get(r.sector || "Unknown");
        // 1 = strongest → normalize to 0..1 (strongest → 1)
        const sectorStrength = rank != null && nSectors > 1 ? 1 - (rank - 1) / (nSectors - 1) : 0.5;
        // Relative strength: stock 55-session return vs NIFTY.
        let relStrength: number | null = null;
        if (niftyReturn55 != null && r.ltp != null && r.ema_50 != null && r.ema_50 !== 0) {
          const base = r.ema_100 ?? r.ema_50;
          const stockTrendPct = ((r.ltp - base) / base) * 100;
          relStrength = stockTrendPct - (niftyClose != null && niftyReturn55 != null ? niftyReturn55 * 0.5 : 0);
        }
        const snap = snapFromRow(r);
        const ctx = { sectorStrength, regime, relStrengthNifty: relStrength, deliveryPct: r.delivery_percent ?? null };
        const bs = breakoutScore(snap, ctx);
        const ps = preBreakoutScore(snap, ctx);
        const { error } = await svc.from("market_data").update({
          sector_strength: Math.round(sectorStrength * 100) / 100,
          rel_strength_nifty: relStrength != null ? Math.round(relStrength * 100) / 100 : null,
          breakout_score: bs.score,
          prebreakout_score: ps.score,
          score_components: { breakout: bs.components, prebreakout: ps.components },
          last_updated: new Date().toISOString(),
        }).eq("symbol", r.symbol).eq("exchange", r.exchange);
        if (!error) updated++;
      }));
    }

    // ---- Portfolio value snapshots — once daily, now that today's EOD
    // closes are in `rows`. A holding whose symbol has no close this run
    // (not yet synced) makes that user's total_value/total_pnl null rather
    // than an understated number that looks complete — same null-safety
    // contract as holdingPnl() in src/lib/market/pnl.ts, reimplemented here
    // rather than importing across the frontend/edge-function boundary.
    try {
      const { data: allHoldings } = await svc.from("market_holdings")
        .select("user_id,symbol,exchange,quantity,avg_price");
      if (allHoldings?.length) {
        const closeByKey = new Map<string, number>();
        for (const r of rows) if (r.ltp != null) closeByKey.set(`${r.symbol}:${r.exchange}`, r.ltp);
        const byUser = new Map<string, { value: number; invested: number; unresolved: number }>();
        for (const h of allHoldings) {
          const cur = byUser.get(h.user_id) ?? { value: 0, invested: 0, unresolved: 0 };
          const invested = Number(h.avg_price) * Number(h.quantity);
          cur.invested += invested;
          const ltp = closeByKey.get(`${h.symbol}:${h.exchange}`);
          if (ltp != null) cur.value += ltp * Number(h.quantity);
          else cur.unresolved++;
          byUser.set(h.user_id, cur);
        }
        const snapshotRows = [...byUser.entries()].map(([user_id, v]) => ({
          user_id, snapshot_date: today,
          total_value: v.unresolved === 0 ? v.value : null,
          total_invested: v.invested,
          total_pnl: v.unresolved === 0 ? v.value - v.invested : null,
          unresolved_count: v.unresolved,
        }));
        if (snapshotRows.length > 0) {
          await svc.from("market_portfolio_snapshots").upsert(snapshotRows, { onConflict: "user_id,snapshot_date" });
        }
      }
    } catch { /* portfolio snapshots are a nice-to-have — never fail the aggregates pass over this */ }

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
