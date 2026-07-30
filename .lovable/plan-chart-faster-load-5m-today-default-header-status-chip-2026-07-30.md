# Chart: faster load, 5m/today default, header status chip

## 1. Make the chart appear faster
Today the chart blocks on a cold edge-function call, and it often fires twice:
the exchange (NSE/BSE) is resolved by a separate database query first, and when
that resolves the candle query key changes and the chart refetches from scratch.

- Resolve exchange without blocking: start the candle request immediately with
  the assumed exchange, and only refetch if the resolved listing differs.
- Keep previous data across timeframe/symbol changes so the chart doesn't drop
  back to a blank "loading candles…" state once something is on screen.
- Raise the cache window so re-opening a chart you viewed recently paints
  instantly from cache while a refresh runs behind it.
- Request a smaller intraday payload: 5m currently pulls 60 days of bars; the
  default view only needs the current session plus a small buffer.
- Cache the resolved listing exchange per symbol so revisits skip that lookup.

## 2. Default to 5m, showing only today's candles
- Change the default timeframe from `1D` to `5m` for charts opened without a
  saved per-symbol preference. Symbols where you previously picked a timeframe
  keep that choice.
- On first render of an intraday chart, set the visible range to the current
  (or most recent) trading day only, instead of fitting the whole history.
  Panning/zooming back to older bars still works.

## 3. Move the data-status ribbon into the chart header
- Remove the full-width ribbon above the chart.
- Render the same status text ("LIVE LAST BAR · history: cache…", "CACHED…",
  "DELAYED…") as a compact chip in the panel header, placed immediately before
  the NSE chip, with the retry button beside it.
- Long text truncates in the chip with the full message on hover so the header
  stays one line.

## Technical notes
- `src/lib/market/hooks.ts` — `useCandles`: `placeholderData: keepPreviousData`,
  longer `staleTime`/`gcTime`, optional range hint for intraday.
- `src/routes/market/Analysis.tsx` — `defaultState.tf = "5m"`; non-blocking
  exchange resolution; header `actions` renders status chip + retry before
  `<Chip>{exchange}</Chip>`; remove the ribbon block.
- `src/components/market/CandleChart.tsx` — initial visible range for intraday
  derived from the last bar's trading day rather than `fitContent`.
- `supabase/functions/market-candles/index.ts` — honour the range hint so
  intraday defaults fetch days, not months.