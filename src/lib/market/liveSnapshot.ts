// Client-side live technical recompute. Kotak's session is a REST API, not a
// streaming feed we can hold open from a stateless edge function — so instead
// of waiting for the nightly EOD pipeline, we take the cached daily candles
// already on screen, reprice "today's" bar with the live LTP (polled ~1s), and
// rerun the exact same indicator/scoring math the backend uses. Only ever
// applied to the single symbol currently open in Analysis — not the whole
// universe.
import { computeSnapshot, type Candle, type IndicatorSnapshot } from "../../../supabase/functions/_shared/market/indicators";
import { breakoutScore, preBreakoutScore, type MarketContext, type ScoreResult } from "../../../supabase/functions/_shared/market/scoring";
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
    // Once the session's over, stop repricing today's bar off the live tick —
    // let the EOD-sourced close (backed by the pipeline's settled print) stand
    // instead of freezing on whichever LTP arrived last before the market shut.
    // Previously this fell through to the append branch below, which stuck a
    // second, spurious "today" bar (built from previous_close as a fake open)
    // on top of the real EOD bar any time this ran post-close.
    if (!marketOpen()) return base;
    base[base.length - 1] = {
      ...last,
      close: quote.ltp,
      high: Math.max(last.high, quote.ltp),
      low: Math.min(last.low, quote.ltp),
    };
    return base;
  }

  // No bar for today yet. Only synthesize an in-progress one while the market
  // is actually open (pipeline hasn't caught up) — outside session hours
  // (weekend/holiday/pre-open) there's no real "today" candle to fabricate
  // from a stale LTP.
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
  breakout: ScoreResult;
  prebreakout: ScoreResult;
}

// Recompute the full technical snapshot + breakout/pre-breakout scores from
// the live-repriced series. Sector strength / breadth regime / relative
// strength are carried over from the last EOD row — those are cross-sectional
// (whole-market) computations that don't meaningfully shift tick to tick.
export function computeLiveScore(
  dailyCandles: CandleDto[] | undefined,
  quote: Quote | undefined,
  eodScore: StockScore | undefined,
  breadth: BreadthDaily | null | undefined,
): LiveScore | null {
  if (!dailyCandles || dailyCandles.length === 0) return null;
  const candles = withLivePrice(dailyCandles, quote);
  const snapshot = computeSnapshot(candles);
  if (!snapshot) return null;
  const ctx: MarketContext = {
    sectorStrength: eodScore?.sector_strength ?? null,
    regime: breadth?.regime ?? null,
    relStrengthNifty: eodScore?.rel_strength_nifty ?? null,
    deliveryPct: eodScore?.delivery_pct ?? null,
  };
  return {
    snapshot,
    breakout: breakoutScore(snapshot, ctx),
    prebreakout: preBreakoutScore(snapshot, ctx),
  };
}
