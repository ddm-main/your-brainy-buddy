# Chart intervals: per-interval default windows + rendering fixes

## Current behaviour (verified)

- `Analysis.tsx:719` opens **every** intraday timeframe on the last trading day only (`todayBarCount`), and non-intraday on the `range` dropdown (default persisted, `1Y/3Y/5Y/ALL`). `IndexDetail.tsx:308` does the same with no range at all.
- Data fetched is decoupled from what is shown: `useCandles` (`hooks.ts:667`) asks the backend for `range: "5d"` for any `Nm` timeframe (so 15m only has 5 days available, not 8), `1h` falls to the backend default `max`, and `1D` gets `30d` unless the cache is shallow (`market-candles/index.ts:443`), so a 2-year daily default view isn't guaranteed.
- Backend interval map already supports deeper windows: 1m→7d, 5m→60d, 15m/1h→max.

## Default view per interval (your values, aligned to TradingView/Kite norms)

| Interval | Fetch window | Default visible window |
|---|---|---|
| 1m | 7d | last **1 full trading session** (rolling: 10:00 yesterday → now) |
| 5m | 10d | last **4 trading days** |
| 15m | 20d | last **8 trading days** |
| 1h | 3mo | last **1 month** |
| 1D | max | last **2 years** |
| 1W | max | last 5 years |
| 1M | max | all |

Notes on industry standard: TradingView/Kite always keep more history loaded than shown, and the default window is time-based (calendar days back from the newest bar), not a fixed bar count — so half-days and holidays don't shift the view. The plan uses that: compute the first bar at/after `newestBarTime − N sessions/months` and set the logical range to it. Panning left still reveals everything fetched.

For 1m specifically, "last full trading day" is implemented as a rolling 1-session window: from the same clock time on the previous session through the newest bar, so at 10:00 you see 10:00 yesterday → 10:00 today, exactly as asked.

## Changes

1. **One shared window table** in `ChartToolbar.tsx` (next to `TIMEFRAMES`): per-timeframe `fetchRange` and `defaultWindow` (sessions / months / years / rolling-session). Replaces the ad-hoc `rangeToBars` guesswork for defaults.
2. **`useCandles`** passes the per-timeframe `fetchRange` instead of the blanket `5d`, and requests a deep daily range for `1D` so 2 years is actually present.
3. **`Analysis.tsx` and `IndexDetail.tsx`** compute `visibleBars` from the newest bar's timestamp using the shared table (IST session grouping, same as today's `todayBarCount`), for intraday **and** daily. The manual range dropdown keeps overriding the default when the user picks one.
4. **Switching interval re-frames the chart** to that interval's default window: extend the chart identity in `CandleChart.tsx` so a timeframe change resets the preserved zoom (it already keys on `viewportKey`, which includes tf on Analysis — will confirm the same for IndexDetail) — user zoom within an interval stays sticky as it does now.

## Rendering issues to fix in the same pass (vs TradingView behaviour)

- `rightOffset: 5` is applied only when session breaks are off; TradingView always leaves right-hand air. Make the offset consistent and independent of the session-breaks toggle.
- `timeVisible` is derived from `typeof time === "number"`, so a daily series delivered as epoch numbers renders hour:minute on the axis. Drive it from `isIntraday(tf)` instead.
- `secondsVisible` is never set — 1m crosshair labels can show seconds. Set it false.
- Time axis repeats the same date across a session boundary (documented previously in the chart time-axis notes); the tick formatter should print date on the first bar of a session and time within it.
- No `fixLeftEdge`/`fixRightEdge` guard: scrolling past the first/last bar leaves the chart empty. Enable edge clamping like TradingView.
- Default window is applied before indicator panes finish sizing, which can visually re-frame once — apply the range after the pane layout settles.
- `visibleBars` fallback `fitContent()` squashes long daily history when a range isn't resolvable; with the new table it always resolves.

## Technical files

- `src/components/market/ChartToolbar.tsx` — window table + helpers.
- `src/lib/market/hooks.ts` — per-timeframe fetch range for candles.
- `src/routes/market/Analysis.tsx`, `src/routes/market/IndexDetail.tsx` — default viewport from the table.
- `src/components/market/CandleChart.tsx` — time-scale options, axis formatter, re-frame on interval change.
