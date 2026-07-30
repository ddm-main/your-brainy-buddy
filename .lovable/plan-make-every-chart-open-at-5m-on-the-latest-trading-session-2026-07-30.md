# Make every chart open at 5m on the latest trading session

## Confirmed cause

- The source default is already `5m`, but `Analysis.tsx` restores the global and per-symbol timeframe from `localStorage`; existing `1D` values therefore override that default indefinitely.
- The “today” viewport is only applied after an intraday timeframe is active. Its session grouping also uses the browser’s local timezone, and the chart can preserve a previous logical range across rebuilds.
- The status message is already rendered in the chart header before the NSE/BSE chip, matching the requested placement.

## Implementation

1. **Make 5m authoritative when a chart opens**
   - Initialize every stock chart at `5m`, regardless of old global or per-symbol timeframe values.
   - Reset to `5m` when navigating directly from one symbol chart to another.
   - Stop persisting/restoring timeframe as a chart default; retain persistence for chart type, indicators, settings, and saved layouts.
   - A manually selected interval will still work for the currently open chart.

2. **Open on only the latest trading session**
   - Group intraday candles by `Asia/Kolkata` trading date rather than browser-local date.
   - Give the chart viewport an explicit symbol/exchange/timeframe identity so an old zoom or daily range cannot be restored onto a newly opened 5m chart.
   - Set the initial logical range to the bars from the newest available trading session; older bars remain available by panning left.

3. **Keep the faster data path**
   - Keep 5m requests on the shallow intraday range and preserve query caching/previous data while refreshing.
   - Confirm the request sent by the page is `timeframe: 5m` with the shallow range rather than a daily/full-history request.

## Validation

- Open TECHM and another symbol from a fresh navigation and confirm `5m` is selected both times.
- Confirm the first visible candle and time axis belong only to the latest available NSE/BSE trading session.
- Switch manually to `1D`, navigate away, then open a chart again and confirm it starts at `5m` rather than restoring `1D`.
- Confirm the compact data-status chip remains immediately before the exchange chip.

## Technical files

- `src/routes/market/Analysis.tsx` — remove persisted timeframe precedence, reset on symbol navigation, and calculate latest-session bars in IST.
- `src/components/market/CandleChart.tsx` — reset/preserve viewport using an explicit chart identity.