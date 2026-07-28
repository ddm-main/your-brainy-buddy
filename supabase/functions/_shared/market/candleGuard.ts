// Grain guard for anything about to be persisted into market_daily_prices.
//
// Upstream providers (Yahoo in particular, with range=max) can silently return
// weekly/monthly bars for a daily request. Those rows are not merely sparse —
// their open/high/low are period aggregates, so they corrupt indicators, 52w
// levels and the Analysis chart. Refuse to write anything that isn't daily.
export interface TimedCandle { time: number }

const DAY = 86_400;
// Real daily NSE data averages ~21 sessions/month. Weekly is ~4.3, monthly 1.
// Anything below 5 bars/month over the covered span is the wrong grain.
const MIN_BARS_PER_MONTH = 5;

export function isDailyGrain(candles: TimedCandle[]): boolean {
  if (candles.length < 3) return true; // too short to judge; caller decides
  const first = candles[0].time;
  const last = candles[candles.length - 1].time;
  const spanDays = (last - first) / DAY;
  if (spanDays < 60) return true; // short window — density test is meaningless
  const months = spanDays / 30.4375;
  return candles.length / months >= MIN_BARS_PER_MONTH;
}

export function grainReason(candles: TimedCandle[]): string {
  const first = candles[0]?.time ?? 0;
  const last = candles[candles.length - 1]?.time ?? 0;
  const months = Math.max(1, (last - first) / DAY / 30.4375);
  return `wrong candle grain: ${candles.length} bars over ${months.toFixed(0)} months ` +
    `(${(candles.length / months).toFixed(1)}/month) — provider returned weekly/monthly for a daily request`;
}
