// Client-side live technical recompute. Kotak's session is a REST API, not a
// streaming feed we can hold open from a stateless edge function — so instead
// of waiting for the nightly EOD pipeline, we take the cached daily candles
// already on screen, reprice "today's" bar with the live LTP (polled ~1s), and
// rerun the exact same indicator/scoring math the backend uses. Only ever
// applied to the single symbol currently open in Analysis — not the whole
// universe.
import { computeSnapshot, computeWeeklySnapshot, type Candle, type IndicatorSnapshot } from "../../../supabase/functions/_shared/market/indicators";
import { detectPatterns, mfi, percentB, supertrend, type PatternFlags } from "../../../supabase/functions/_shared/market/indicators-advanced";
import { breakoutScoreV4, evaluateLiquidity, type AdvancedSignals, type BreakoutPatterns, type MarketContext } from "../../../supabase/functions/_shared/market/scoring";
import { vwap } from "../../../supabase/functions/_shared/market/indicators-advanced";
import { marketOpen } from "./hooks";
import type { BreadthDaily, CandleDto, Quote, StockScore } from "./types";

function toUnix(time: string | number): number {
  return typeof time === "number" ? time : Math.floor(new Date(`${time}T00:00:00Z`).getTime() / 1000);
}

export function todayIstDateString(): string {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  return ist.toISOString().slice(0, 10);
}

// Reprice the most recent daily bar (or synthesize today's) using the live LTP.
export function withLivePrice(dailyCandles: CandleDto[], quote: Quote | undefined): Candle[] {
  const base: Candle[] = dailyCandles.map((c) => ({
    time: toUnix(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  }));
  if (!quote?.ltp) return base;
  const today = todayIstDateString();
  const last = base[base.length - 1];
  const lastDateStr = last ? new Date(last.time * 1000).toISOString().slice(0, 10) : null;

  if (last && lastDateStr === today) {
    // Once the session's over, stop repricing today's bar off the live tick.
    if (!marketOpen()) return base;
    base[base.length - 1] = {
      ...last,
      close: quote.ltp,
      high: Math.max(last.high, quote.ltp),
      low: Math.min(last.low, quote.ltp),
    };
    return base;
  }

  if (!marketOpen()) return base;
  const open = quote.previous_close ?? last?.close ?? quote.ltp;
  base.push({
    time: Math.floor(Date.now() / 1000),
    open,
    high: Math.max(open, quote.ltp),
    low: Math.min(open, quote.ltp),
    close: quote.ltp,
    volume: last?.volume ?? 0,
  });
  return base;
}

export interface LiveScore {
  snapshot: IndicatorSnapshot;
  // Deliberately the SAME v4 engine the EOD pipeline and the UI's score
  // explainer use — the live view used to run the legacy v2 scorer, so the
  // number moved by several points at the open for no reason other than which
  // function computed it.
  breakout: { score: number | null; components: Record<string, number> };
  patterns: PatternFlags;
}

// Recompute the full technical snapshot + breakout score from the
// live-repriced series. Sector strength / breadth regime / relative
// strength are carried over from the last EOD row — those are cross-sectional
// (whole-market) computations that don't meaningfully shift tick to tick.
// Pattern detection also runs on the live-repriced series so hammer /
// engulfing / cup-and-handle-triggered flags update as the session forms.
export function computeLiveScore(
  dailyCandles: CandleDto[] | undefined,
  quote: Quote | undefined,
  eodScore: StockScore | undefined,
  breadth: BreadthDaily | null | undefined,
  // Market cap in ₹ Cr, when the caller has fundamentals loaded. Optional: the
  // recompute must still work on first paint, before that query resolves.
  marketCapCr?: number | null,
): LiveScore | null {
  if (!dailyCandles || dailyCandles.length === 0) return null;
  const candles = withLivePrice(dailyCandles, quote);
  const snapshot = computeSnapshot(candles);
  if (!snapshot) return null;
  // Stability cap: keep the EOD S/R visible unless the live close has cleared
  // it by more than 0.25 × ATR.
  const atrV = snapshot.atr14 ?? null;
  const tol = atrV ? 0.25 * atrV : 0;
  const eodR = eodScore?.resistance_level ?? null;
  const eodS = eodScore?.support_level ?? null;
  if (eodR != null && snapshot.close < eodR + tol) {
    snapshot.resistance = eodR;
    snapshot.resistanceFallback = false;
  }
  if (eodS != null && snapshot.close > eodS - tol) {
    snapshot.support = eodS;
    snapshot.supportFallback = false;
  }
  const ctx: MarketContext = {
    sectorStrength: eodScore?.sector_strength ?? null,
    regime: breadth?.regime ?? null,
    relStrengthNifty: eodScore?.rel_strength_nifty ?? null,
    deliveryPct: eodScore?.delivery_pct ?? null,
  };
  const patterns = detectPatterns(candles);
  const bp: BreakoutPatterns = {
    bullishEngulfing: patterns.bullish_engulfing,
    bearishEngulfing: patterns.bearish_engulfing,
    hammer: patterns.hammer,
    shootingStar: patterns.shooting_star,
    doji: patterns.doji,
    cupAndHandle: patterns.cup_and_handle,
    cupAndHandleTriggered: patterns.cup_and_handle_triggered,
    flag: patterns.flag,
    ascendingTriangle: patterns.ascending_triangle,
    doubleBottom: patterns.double_bottom,
    inverseHeadShoulders: patterns.inverse_head_shoulders,
    fallingWedge: patterns.falling_wedge,
  };
  const st = supertrend(candles);
  const mfiSeries = mfi(candles, 14);
  const vwapSeries = vwap(candles);
  const vwapLast = vwapSeries[vwapSeries.length - 1] ?? null;
  const stDir = st.dir[st.dir.length - 1] ?? null;
  const adv: AdvancedSignals = {
    vwapRel: vwapLast != null && vwapLast > 0 ? (snapshot.close - vwapLast) / vwapLast : null,
    percentB: percentB(snapshot.close, snapshot.bbUpper, snapshot.bbLower),
    mfi14: mfiSeries[mfiSeries.length - 1] ?? null,
    supertrendDir: stDir === 1 || stDir === -1 ? stDir : null,
    patterns: {
      bullishEngulfing: patterns.bullish_engulfing, hammer: patterns.hammer, doji: patterns.doji,
      cupAndHandle: patterns.cup_and_handle, flag: patterns.flag,
      ascendingTriangle: patterns.ascending_triangle,
      bearishEngulfing: patterns.bearish_engulfing, shootingStar: patterns.shooting_star,
    },
  };
  // Liquidity feeds two things in v4: the 25-point illiquidity penalty and the
  // turnover floor under the relative-volume factor. Omitting it here made the
  // live recompute read "turnover unknown" and silently drop that factor, so
  // the live score drifted from the stored one for no reason but a missing
  // argument. Market cap is only gated on when the caller supplies it —
  // otherwise the cap leg abstains rather than falsely failing the stock.
  const avgTurnoverCr = snapshot.volAvg20 != null && snapshot.close != null
    ? (snapshot.volAvg20 * snapshot.close) / 1e7
    : null;
  const liquidity = marketCapCr != null
    ? evaluateLiquidity({ close: snapshot.close, marketCapCr, avgTurnoverCr })
    : { ok: true, reasons: [] };
  const v4 = breakoutScoreV4({
    s: snapshot,
    ctx,
    patterns: bp,
    weekly: computeWeeklySnapshot(candles),
    adv,
    barsAvailable: candles.length,
    liquidity,
    avgTurnoverCr,
  });
  return {
    snapshot,
    breakout: {
      score: v4.score,
      components: { ...v4.buckets, ...v4.components, ...v4.penalties },
    },
    patterns,
  };
}
