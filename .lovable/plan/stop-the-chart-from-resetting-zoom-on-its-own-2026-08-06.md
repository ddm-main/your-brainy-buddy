# Stop the chart from resetting zoom on its own

## What's happening

`CandleChart` fully rebuilds the chart on every candle refresh (the effect depends on the candle array). On rebuild it decides the viewport from a "candles key" made of bar count + first bar time + last bar time:

- If that key is unchanged, it restores the range you were on.
- If it changed at all, it calls `fitContent()` (or snaps to the default window) — which is the zoomed-out second screenshot.

For an intraday 5m index chart the key changes on almost every poll: a new bar appears, and the rolling intraday window drops the oldest bar so the first bar time shifts too. Result: your zoom is discarded a few seconds after you set it.

Two extra contributors on this page:
- `IndexDetail.tsx` renders `CandleChart` without a `viewportKey`, so the component has no way to tell "same chart, new data" from "different chart".
- The saved range is only captured on teardown, so it also isn't preserved when a rebuild path chooses the fit branch.

## The fix

1. **Treat data growth as "same chart".** Only re-fit the viewport when the chart identity changes (symbol, exchange, timeframe, chart type/scale reset) — not when bars are appended, updated, or trimmed. Appending/updating bars keeps the current visible range untouched.
2. **Track the user's range continuously.** Subscribe to visible-range changes and store the latest range as it moves, instead of only on unmount, and mark the chart as "user has interacted" the first time they pan or zoom. Once interacted, no automatic re-fit happens for that chart.
3. **Keep the first-open behaviour.** A freshly opened chart still opens on the latest session (intraday) or the default bar window; only automatic re-fits after that are removed.
4. **Give IndexDetail a viewport identity.** Pass a `viewportKey` (`index:<symbol>:<tf>`) and the same intraday visible-bars default that Analysis uses, so switching index or timeframe intentionally re-frames, and nothing else does.
5. **Preserve behaviour for explicit actions.** Timeframe buttons, "reset zoom" (Alt+H), and pattern focus jumps still move the viewport, since those are user-initiated.

## Technical notes

- `src/components/market/CandleChart.tsx`
  - Replace the `candlesKey` fit decision with an identity check on `viewportKey` + chart type/log-scale, plus a `userInteractedRef`.
  - Add `chart.timeScale().subscribeVisibleLogicalRangeChange` to keep `rangeRef` current and set `userInteractedRef` on user-driven changes.
  - Always restore `rangeRef` on rebuild when identity is unchanged; fit only on identity change and only if the user hasn't interacted with that identity yet.
- `src/routes/market/IndexDetail.tsx` — pass `viewportKey` and `visibleBars` to `CandleChart`.

## Validation

- Open NIFTY 50 5m, zoom into ~1 hour, wait through several polls and a new 5m bar: the view stays put.
- Switch 5m → 1D → 5m: re-frames as expected on each switch.
- Alt+H still resets to full history.
