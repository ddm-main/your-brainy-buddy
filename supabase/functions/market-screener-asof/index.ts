// market-screener-asof — compute a Screener row set as of a past trading date.
// OHLCV comes from market_daily_prices (adjusted). All technical indicators
// (EMA/RSI/MACD/ADX/ATR/BB/52w/returns/breakout scores) are recomputed on the
// fly via the shared indicators.computeSnapshot + scoring modules. Fundamentals
// and market cap use the latest snapshot from market_screener_rows (there is
// no historical fundamentals table) — the UI flags this to the user.

import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { computeSnapshot, computeWeeklySnapshot, type Candle } from "../_shared/market/indicators.ts";
import { detectPatterns } from "../_shared/market/indicators-advanced.ts";
import { breakoutScoreV4, preBreakoutScore, evaluateLiquidity, type MarketContext } from "../_shared/market/scoring.ts";

type Universe = "all" | "nifty50" | "nifty500";

interface Body { as_of?: string; universe?: Universe }

const OK_UNIVERSES: Universe[] = ["all", "nifty50", "nifty500"];

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// PostgREST errors are plain objects, not Errors — throwing them raw made the
// catch below serialize "[object Object]" to the client with no diagnostics.
function pgFail(label: string, error: unknown): Error {
  const e = error as { message?: string; code?: string; details?: string } | null;
  const parts = [e?.message, e?.code ? `(code ${e.code})` : null, e?.details].filter(Boolean);
  console.error(`${label} failed:`, JSON.stringify(error));
  return new Error(`${label}: ${parts.join(" ") || String(error)}`);
}

// Only the columns this function actually reads. `select("*")` on a 100-column
// view for the whole universe is a large scan/payload and was prone to timing
// out (which surfaced as the opaque 500).
const SNAP_COLS = [
  "symbol", "company_name", "sector", "sub_sector", "industry", "instrument_type",
  "market_cap", "is_nifty500", "fno_enabled", "sme",
  "pe_ttm", "pb", "peg", "eps_ttm", "book_value", "dividend_yield", "roe", "roce",
  "debt_to_equity", "current_ratio", "quick_ratio", "revenue_ttm_cr", "profit_ttm_cr",
  "revenue_growth_yoy", "profit_growth_yoy", "eps_growth_yoy",
  "promoter_holding", "fii_holding", "dii_holding",
].join(",");


async function fetchUniverseSymbols(svc: any, universe: Universe): Promise<string[]> {
  // Latest-snapshot rows (active NSE equities) — this is the population.
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc
      .from("market_screener_rows")
      .select("symbol,is_nifty500,fno_enabled,sme,instrument_type")
      .eq("is_active", true).eq("exchange", "NSE")
      .range(from, from + 999);
    if (error) throw pgFail("load universe", error);
    const chunk = data ?? [];
    rows.push(...chunk);
    if (chunk.length < 1000) break;
  }
  const eq = rows.filter((r) => r.instrument_type === "EQ");
  if (universe === "all") return eq.map((r) => r.symbol);
  if (universe === "nifty500") return eq.filter((r) => r.is_nifty500).map((r) => r.symbol);
  // nifty50 → resolve via market_index_members
  const { data: mem } = await svc.from("market_index_members").select("symbol").eq("index_key", "NIFTY50");
  const set = new Set((mem ?? []).map((r: any) => r.symbol));
  return eq.filter((r) => set.has(r.symbol)).map((r) => r.symbol);
}

async function fetchSnapshots(svc: any, symbols: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (let i = 0; i < symbols.length; i += 500) {
    const slice = symbols.slice(i, i + 500);
    const { data, error } = await svc
      .from("market_screener_rows")
      .select(SNAP_COLS)
      .eq("exchange", "NSE")
      .in("symbol", slice);
    if (error) throw pgFail("load snapshots", error);
    (data ?? []).forEach((r: any) => out.set(r.symbol, r));
  }
  return out;
}

// Historical market context for the as-of date. Using today's sector strength
// / relative strength (as this function used to) leaks future information into
// a historical screen. Sector strength comes from the daily sector table;
// regime from the daily breadth table. Relative strength vs Nifty is not
// stored per-date anywhere, so it stays null rather than borrowing today's.
async function fetchAsOfContext(svc: any, asOf: string): Promise<{
  sectorStrength: Map<string, number>;
  regime: string | null;
  available: boolean;
}> {
  const sectorStrength = new Map<string, number>();
  const [{ data: sectors }, { data: breadth }] = await Promise.all([
    svc.from("market_sector_strength_daily").select("sector,strength_rank").eq("trade_date", asOf),
    svc.from("market_breadth_daily").select("regime").eq("trade_date", asOf).maybeSingle(),
  ]);
  const ranked = (sectors ?? []).filter((r: any) => r.strength_rank != null);
  const n = ranked.length;
  for (const r of ranked) {
    sectorStrength.set(r.sector ?? "Unknown", n > 1 ? 1 - (Number(r.strength_rank) - 1) / (n - 1) : 0.5);
  }
  const regime = breadth?.regime ?? null;
  return { sectorStrength, regime, available: n > 0 || regime != null };
}

async function resolveTradingDate(svc: any, asOf: string): Promise<{ resolved: string | null; earliest: string | null }> {
  const [{ data: onOrBefore }, { data: earliestRow }] = await Promise.all([
    svc.from("market_daily_prices").select("trade_date").eq("exchange", "NSE")
      .lte("trade_date", asOf).order("trade_date", { ascending: false }).limit(1).maybeSingle(),
    svc.from("market_daily_prices").select("trade_date").eq("exchange", "NSE")
      .order("trade_date", { ascending: true }).limit(1).maybeSingle(),
  ]);
  return {
    resolved: (onOrBefore as any)?.trade_date ?? null,
    earliest: (earliestRow as any)?.trade_date ?? null,
  };
}

async function fetchDailyPrices(svc: any, symbols: string[], asOf: string, bars = 260): Promise<Map<string, Candle[]>> {
  // One RPC per batch of symbols returns only the last `bars` sessions on or
  // before as_of, as compact [date,o,h,l,c,v] tuples. The previous PostgREST
  // paging strategy needed hundreds of round-trips for the full universe and
  // could not finish inside the edge-function budget.
  const byBucket = new Map<string, Candle[]>();
  const CHUNK = 250;
  const CONCURRENCY = 4;
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += CHUNK) batches.push(symbols.slice(i, i + CHUNK));

  const queue = [...batches];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const slice = queue.shift();
      if (!slice) break;
      const { data, error } = await svc.rpc("market_asof_candles", {
        _as_of: asOf, _symbols: slice, _bars: bars,
      });
      if (error) throw pgFail("load as-of candles", error);
      for (const row of (data ?? []) as { symbol: string; candles: any[][] }[]) {
        const list: Candle[] = [];
        for (const t of row.candles ?? []) {
          const [d, o, h, l, c, v] = t;
          if (c == null) continue;
          const close = Number(c);
          list.push({
            time: Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000),
            open: Number(o ?? close), high: Number(h ?? close), low: Number(l ?? close),
            close, volume: Number(v ?? 0),
          });
        }
        if (list.length > 0) byBucket.set(row.symbol, list);
      }
    }
  });
  await Promise.all(workers);
  return byBucket;
}


function retNPct(candles: Candle[], n: number): number | null {
  if (candles.length < n + 1) return null;
  const now = candles[candles.length - 1].close;
  const then = candles[candles.length - 1 - n].close;
  return then ? ((now - then) / then) * 100 : null;
}

function retYtdPct(candles: Candle[], asOf: string): number | null {
  if (candles.length === 0) return null;
  const year = asOf.slice(0, 4);
  const first = candles.find((c) => new Date(c.time * 1000).getUTCFullYear() === Number(year));
  if (!first) return null;
  const last = candles[candles.length - 1].close;
  return first.close ? ((last - first.close) / first.close) * 100 : null;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const auth = await requireUserId(req);
    if ("error" in auth) return auth.error;
    const body: Body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const requested = String(body.as_of ?? "");
    const universe: Universe = (OK_UNIVERSES.includes(body.universe as any) ? body.universe : "all") as Universe;
    if (!isIsoDate(requested)) return errorResponse(req, "as_of must be YYYY-MM-DD", 400);

    const svc = svcClient();
    // Weekends/holidays snap back to the last session that actually traded.
    const { resolved, earliest } = await resolveTradingDate(svc, requested);
    if (!resolved) {
      return errorResponse(
        req,
        earliest
          ? `no price history on or before ${requested} — history starts ${earliest}`
          : "no daily price history available yet",
        400,
      );
    }
    const asOf = resolved;

    const symbols = await fetchUniverseSymbols(svc, universe);
    if (symbols.length === 0) {
      return jsonResponse(req, { as_of: asOf, requested_as_of: requested, earliest_as_of: earliest, universe, count: 0, rows: [] });
    }

    const [snapshots, priceMap, asOfCtx] = await Promise.all([
      fetchSnapshots(svc, symbols),
      fetchDailyPrices(svc, symbols, asOf, 260),
      fetchAsOfContext(svc, asOf),
    ]);

    // Coverage telemetry — with a shallow price history most symbols are
    // silently skipped; the UI needs to say so rather than show a short list
    // as if it were the whole universe.
    let skippedNoHistory = 0;
    let skippedShortHistory = 0;

    const rows: any[] = [];
    for (const sym of symbols) {
      const snap = snapshots.get(sym); if (!snap) continue;
      const candles = priceMap.get(sym) ?? [];
      if (candles.length === 0) { skippedNoHistory++; continue; }
      if (candles.length < 30) { skippedShortHistory++; continue; }
      // The last stored bar must be the as-of session itself, otherwise the
      // row's "close" belongs to some earlier day and would silently pass
      // price/return filters for a date it never traded on.
      const lastDate = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);
      if (lastDate !== asOf) { skippedNoHistory++; continue; }

      const ind = computeSnapshot(candles); if (!ind) continue;
      const ctx: MarketContext = {
        sectorStrength: asOfCtx.sectorStrength.get(snap.sector ?? "Unknown") ?? null,
        regime: asOfCtx.regime,
        // Not stored historically — null scores 0 rather than leaking today's value.
        relStrengthNifty: null,
        deliveryPct: null,
      };
      // v4 — the same engine the EOD pipeline, the score explainer and the live
      // Analysis recompute use. This path used to run the legacy v2 scorer, so
      // an as-of replay of a session disagreed with the stored score for it.
      const p = detectPatterns(candles);
      // Same liquidity gate the EOD pipeline applies. Without it this replay
      // skipped the 25-point illiquidity penalty and dropped the relative-volume
      // factor as "turnover unknown", so an as-of run disagreed with the score
      // actually stored for that session — the exact drift this path exists to
      // rule out.
      const avgTurnoverCr = ind.volAvg20 != null && ind.close != null
        ? (ind.volAvg20 * ind.close) / 1e7
        : null;
      const liquidity = evaluateLiquidity({
        close: ind.close,
        marketCapCr: snap.market_cap != null ? Number(snap.market_cap) : null,
        avgTurnoverCr,
      });
      const bo = breakoutScoreV4({
        s: ind,
        ctx,
        patterns: {
          bullishEngulfing: p.bullish_engulfing, bearishEngulfing: p.bearish_engulfing,
          hammer: p.hammer, shootingStar: p.shooting_star, doji: p.doji,
          cupAndHandle: p.cup_and_handle, cupAndHandleTriggered: p.cup_and_handle_triggered,
          flag: p.flag, ascendingTriangle: p.ascending_triangle,
          doubleBottom: p.double_bottom, inverseHeadShoulders: p.inverse_head_shoulders,
          fallingWedge: p.falling_wedge,
        },
        weekly: computeWeeklySnapshot(candles),
        barsAvailable: candles.length,
        liquidity,
        avgTurnoverCr,
      });
      const pb = preBreakoutScore(ind, ctx);
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2] ?? null;
      const changeAbs = prev ? last.close - prev.close : null;
      const changePct = prev && prev.close ? ((last.close - prev.close) / prev.close) * 100 : null;

      rows.push({
        // structural (snapshot — no history)
        symbol: sym,
        exchange: "NSE",
        company_name: snap.company_name,
        sector: snap.sector,
        sub_sector: snap.sub_sector ?? snap.industry ?? snap.sector,
        industry: snap.industry,
        instrument_type: snap.instrument_type ?? "EQ",
        market_cap: snap.market_cap,
        is_nifty500: !!snap.is_nifty500,
        fno_enabled: !!snap.fno_enabled,
        sme: !!snap.sme,
        data_provenance: {
          asof: asOf,
          fundamentals: "latest_snapshot",
          technicals: "recomputed",
          market_context: asOfCtx.available ? "historical" : "unavailable",
          // A replay runs v4 without relative strength, delivery %, fundamentals
          // or tier percentiles, so its number is NOT comparable to the stored
          // one. Stamp the model so the UI can label it instead of implying the
          // two measurements agree.
          model: "breakout_v4_partial_context",
        },

        trade_date: new Date(last.time * 1000).toISOString().slice(0, 10),
        close: last.close,
        previous_close: prev?.close ?? null,
        change_abs: changeAbs,
        change_pct: changePct,
        volume: last.volume,

        rel_volume: ind.relVolume,
        vol_avg30: ind.volAvg30,
        vol_gt_avg30: ind.volAvg30 != null && last.volume > ind.volAvg30,

        ema20: ind.ema20,
        ema50: ind.ema50,
        ema100: ind.ema100,
        ema200: ind.ema200,
        above_ema200: ind.aboveEma200,

        rsi14: ind.rsi14,
        macd: ind.macd,
        macd_signal: ind.macdSignal,
        macd_hist: ind.macdHist,
        adx14: ind.adx14,
        atr14: ind.atr14,
        atr_pct: ind.atrPct,
        bb_upper: ind.bbUpper,
        bb_lower: ind.bbLower,
        bb_width: ind.bbWidth,
        bb_squeeze: ind.bbSqueeze,

        high_52w: ind.high52w,
        low_52w: ind.low52w,
        pct_from_52w_high: ind.pctFrom52wHigh,

        higher_lows: ind.higherLows,
        near_resistance: ind.nearResistance,
        resistance_level: ind.resistance,
        support_level: ind.support,

        sector_strength: ctx.sectorStrength,
        rel_strength_nifty: null,
        breakout_score: bo.score,
        // Same number under the v4 name, so anything ranking on v4 (screener,
        // breakout board) works identically in a replay.
        breakout_score_v4: bo.score,
        breakout_v4_components: { buckets: bo.buckets, factors: bo.components, penalties: bo.penalties },
        breakout_v4_coverage: bo.coverage,
        prebreakout_score: pb.score,
        score_components: {
          breakout: { ...bo.buckets, ...bo.components, ...bo.penalties },
          prebreakout: pb.components,
        },

        ret_5d: retNPct(candles, 5),
        ret_21d: retNPct(candles, 21),
        ret_ytd: retYtdPct(candles, asOf),

        // fundamentals — latest snapshot pass-through
        pe_ttm: snap.pe_ttm,
        pb: snap.pb,
        peg: snap.peg,
        eps_ttm: snap.eps_ttm,
        book_value: snap.book_value,
        dividend_yield: snap.dividend_yield,
        roe: snap.roe,
        roce: snap.roce,
        debt_to_equity: snap.debt_to_equity,
        current_ratio: snap.current_ratio,
        quick_ratio: snap.quick_ratio,
        revenue_ttm_cr: snap.revenue_ttm_cr,
        profit_ttm_cr: snap.profit_ttm_cr,
        revenue_growth_yoy: snap.revenue_growth_yoy,
        profit_growth_yoy: snap.profit_growth_yoy,
        eps_growth_yoy: snap.eps_growth_yoy,
        promoter_holding: snap.promoter_holding,
        fii_holding: snap.fii_holding,
        dii_holding: snap.dii_holding,
      });
    }

    return jsonResponse(req, {
      as_of: asOf,
      requested_as_of: requested,
      earliest_as_of: earliest,
      universe,
      count: rows.length,
      universe_size: symbols.length,
      skipped_no_history: skippedNoHistory,
      skipped_short_history: skippedShortHistory,
      market_context: asOfCtx.available ? "historical" : "unavailable",
      rows,
    });
  } catch (e) {
    console.error("market-screener-asof failed:", e);
    const msg = e instanceof Error
      ? e.message
      : (typeof e === "object" && e !== null
        ? ((e as { message?: string }).message ?? JSON.stringify(e))
        : String(e));
    return errorResponse(req, msg, 500);
  }
});