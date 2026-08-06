# Chart: follow the live edge + industry-standard zoom/pan

## Confirmed causes (read from the code and the live DB)

1. **The chart is torn down and rebuilt on every poll.** The main effect in
   `CandleChart.tsx` depends on `cleanCandles` (line 1123), so every 5s candle
   refresh destroys the chart and recreates it. Every zoom/pan quirk below is
   downstream of that.

2. **Restoring an absolute logical range is what pins you to old candles.** On
   rebuild with the same identity the code replays `rangeRef.current`
   (`{from,to}` bar *indices*, line 1071). When a new bar is appended — and the
   rolling intraday window drops the oldest bar — those indices no longer point
   at the same bars, so the viewport walks backwards in time and never follows
   the live bar. The data itself is fresh: `market_intraday_prices` for EMIL 5m
   has bars up to 04:30 UTC (10:00 IST) fetched seconds ago, so this is a
   viewport bug, not a data bug.

3. **Default frame stops one bar short of the edge.** `to: data.length - 1`
   plus a `rightOffset` of 5 leaves the newest bar hugging the axis instead of
   TradingView's air-to-the-right.

4. **`userInteractedRef` is computed but never used** in the fit decision, so
   "user has taken control" never actually protects or releases the viewport.

5. **Missing time-scale options**: no `fixRightEdge`, no `minBarSpacing`, no
   `shiftVisibleRangeOnNewBar`, no `lockVisibleTimeRangeOnResize`, and wheel/
   pinch/axis-drag behaviour is left at library defaults (`handleScale`,
   `handleScroll`, `kineticScroll` unset).

6. **Fetch depth still doesn't match the window table for non-`Nm` intervals.**
   `TF_FETCH_RANGE` only covers 1m/5m/15m; `1h` sends no range (backend
   `max`), and `1D` gets `30d` unless the backend's own shallow/sparse
   heuristic happens to trigger — so the 2-year daily default isn't guaranteed.
   The backend also ignores a range hint unless the timeframe matches `\d+m`.

## Fix plan

### A. Stop rebuilding; update in place
- Split the chart effect: chart/series/pane creation keyed on *identity*
  (symbol, exchange, timeframe, chart type, scale, settings, pane reset) —
  and a separate data effect that calls `series.setData` / `update` when
  candles change. Indicator/overlay series get the same treatment.
- Result: no teardown on poll, so zoom, pan, crosshair and pane heights survive
  live updates by construction.

### B. Follow the live edge like TradingView/Kite
- Track whether the viewport is at the real-time edge. While it is, new bars
  scroll the view (`shiftVisibleRangeOnNewBar: true`), keeping the forming
  candle visible with right-hand air.
- Once the user scrolls/zooms away from the edge, stop auto-following and hold
  their exact range; restore ranges **anchored to the newest bar** (offset from
  the right edge) rather than absolute indices, so appended/trimmed bars can't
  drag the view backwards.
- Re-frame to the interval's default window only on a genuine identity change
  (symbol/exchange/timeframe/chart type/scale) — as intended today, now
  actually gated on `userInteractedRef`.
- Add a visible "jump to latest" affordance (and keep Alt+H) so returning to
  the live edge is one click; `scrollToRealTime()` on interval change.

### C. Industry-standard zoom/pan
- `rightOffset` retained for air; `fixLeftEdge: true` **and** `fixRightEdge:
  true` so you can't scroll into emptiness on either side.
- `minBarSpacing` set so 1m/5m series can zoom out fully without clipping, and
  `barSpacing` clamped on the way in so a wheel flick can't collapse the frame.
- Wheel/pinch zoom anchored at the cursor with delta-magnitude scaling
  (normalised `deltaMode`), not a fixed factor per event; trackpad pinch
  (`ctrlKey` wheel) handled on a non-passive listener so the page never scrolls
  behind the chart.
- Price-axis drag scales price, time-axis drag scales time, double-click on an
  axis resets that axis — the TradingView contract.
- `lockVisibleTimeRangeOnResize: true` so window/pane resizes don't re-frame,
  and the default window is applied after indicator panes settle.

### D. Fetch depth matches the window table
- Extend `TF_FETCH_RANGE` to every interval: `1m 7d`, `5m 10d`, `15m 20d`,
  `1h 3mo`, `1D/1W/1M max`, and pass it for daily grains too.
- Let `market-candles` honour a range hint for hour and daily grains (not just
  `\d+m`), and force the deep daily fetch when the client asks for `max`, so
  the 2-year daily default view always has data behind it.

## Validation
- EMIL 5m during the session: newest bar is the current 5-minute bucket, the
  chart stays glued to the live edge through several polls, and the last-bar
  close tracks the quote.
- Zoom into ~1 hour and wait through 3+ polls: the range does not move.
- Scroll back two sessions: no auto-follow, no snap-back; "jump to latest"
  returns to the live edge.
- Switch 5m → 1D → 5m: each opens on its default window (4 sessions / 2 years).
- Wheel zoom under the cursor keeps the bar under the pointer fixed; trackpad
  pinch never zooms the page; edges clamp instead of showing blank space.

## Technical files
- `src/components/market/CandleChart.tsx` — split create/update effects,
  edge-anchored viewport, follow-live logic, time-scale + zoom options,
  cursor-anchored wheel/pinch handling.
- `src/lib/market/chartWindows.ts` — full `TF_FETCH_RANGE` map.
- `src/lib/market/hooks.ts` — pass fetch range for hourly/daily grains.
- `supabase/functions/market-candles/index.ts` — honour range hint for `1h`/
  `1D`, force deep daily on `max`.
- `src/routes/market/Analysis.tsx`, `src/routes/market/IndexDetail.tsx` — pass
  identity/window props unchanged where already correct.
