// Settlement guard — "is this session finished and authoritative?"
//
// The EOD pipeline runs on cron throughout the day. A provider's daily series
// always includes today's *forming* bar while the session is live (and, for
// hours after the close, a bar that has not yet been reconciled against the
// NSE bhavcopy). Persisting that bar stamps a partial session into
// market_daily_prices / market_stock_scores for whichever slice of the universe
// the chunked run happened to touch — which is exactly how the screener ended
// up with 1,567 symbols on today's 10:30 IST prices and 1,233 stuck on
// yesterday's close.
//
// Rule: a trade date is settled only when the NSE bhavcopy for that date has
// landed with broad coverage. Everything else is "forming" and must never be
// written to the daily/score tables.
import { istTradeDate } from "./cron.ts";

/** Minimum bhavcopy rows before a date counts as a real, complete session. */
const SETTLED_MIN_ROWS = 500;

export interface SettlementInfo {
  /** Today's IST calendar date. */
  todayIst: string;
  /** True when today's session has a settled (bhavcopy-backed) source. */
  todaySettled: boolean;
  /** Newest trade date that is safe to persist / use as a reference session. */
  settledThrough: string | null;
}

type MinimalClient = {
  from: (t: string) => {
    select: (
      cols: string,
      opts?: { count?: "exact"; head?: boolean },
    ) => any;
  };
};

/** Reads the freshest bhavcopy-backed session from market_eod_nse. */
export async function getSettlement(
  svc: MinimalClient,
  now = new Date(),
): Promise<SettlementInfo> {
  const todayIst = istTradeDate(now);
  let settledThrough: string | null = null;
  try {
    const { data } = await svc.from("market_eod_nse")
      .select("trade_date")
      .eq("exchange", "NSE")
      .order("trade_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const latest = (data?.trade_date as string | null) ?? null;
    if (latest) {
      const { count } = await svc.from("market_eod_nse")
        .select("symbol", { count: "exact", head: true })
        .eq("exchange", "NSE")
        .eq("trade_date", latest);
      if ((count ?? 0) >= SETTLED_MIN_ROWS) settledThrough = latest;
    }
  } catch {
    settledThrough = null;
  }
  return {
    todayIst,
    todaySettled: settledThrough != null && settledThrough >= todayIst,
    settledThrough,
  };
}

/** True when a candle/row for `tradeDate` may be persisted. */
export function isPersistableDate(tradeDate: string, s: SettlementInfo): boolean {
  const d = String(tradeDate).slice(0, 10);
  if (d < s.todayIst) return true;
  return s.todaySettled;
}

/** Trims a chronological daily series down to its settled bars. */
export function settledBars<T extends { time: number }>(
  candles: T[],
  s: SettlementInfo,
): T[] {
  if (s.todaySettled) return candles;
  return candles.filter(
    (c) => new Date(c.time * 1000).toISOString().slice(0, 10) < s.todayIst,
  );
}
