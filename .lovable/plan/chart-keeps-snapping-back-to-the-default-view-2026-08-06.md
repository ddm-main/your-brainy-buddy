# Chart keeps snapping back to the default view

## Confirmed cause (read from the code)

The chart is destroyed and recreated far more often than it should be, and every
rebuild re-applies a viewport.

1. **`priceLines` changes identity on every quote tick.** In `Analysis.tsx` the
   memo at line 562 depends on `liveView` → `liveScore`, which is a `useMemo`
   over `quote` (line 414). The quote refetches every 1–5s during the session,
   so `liveScore` is a new object, `priceLines` is a new array, and
   `CandleChart`'s main effect — which lists `priceLines` in its dependency
   array (line 1260) — tears the chart down and rebuilds it. Mid-gesture that
   kills the wheel/drag interaction and replays a stored range, which reads as
   "it reset itself".

2. **Structural changes still rebuild the whole chart.** The gate at line 419
   only updates the last bar in place; any appended or trimmed bar (every new
   5m bar, every rolling-window trim) bumps `renderTick` and recreates chart,
   series, panes and primitives instead of calling `setData`.

3. **Every rebuild re-applies a range twice** (`applyRange()` plus a second
   pass inside `requestAnimationFrame`, line 1198-1199) with no guard for a
   gesture in flight, so a rebuild landing during a zoom overwrites what the
   user just did.

The time-scale options themselves (`rightOffset`, `minBarSpacing`, free edges,
`handleScale`/`handleScroll`, `lockVisibleTimeRangeOnResize`) are already at
industry-standard values — the problem is the rebuild churn, not the options.

## Fix plan

### A. Stop rebuilding on prop-identity churn
- Inside `CandleChart`, derive a *value* signature for `priceLines` (and any
  other object/array prop feeding the main effect) and depend on the signature,
  not the object identity.
- Move price-line rendering into its own effect that adds/updates/removes lines
  on the existing series, so support/resistance updates never touch the chart.

### B. Update data in place instead of recreating the chart
- Split the main effect into: (1) create chart/series/panes, keyed on identity
  (symbol/timeframe/chart type/scale/settings/studies set/pane reset), and
  (2) a data effect that calls `series.setData(...)` for price, volume and each
  study when bars are appended, trimmed or revalued.
- The current `renderTick` structural rebuild becomes a `setData` refresh; full
  teardown happens only on a real identity change.

### C. Never overwrite a live gesture
- Track an "interaction in flight" flag (pointer down / wheel within the last
  ~250ms). While set, skip programmatic range application entirely.
- Apply the range once on identity change, not twice per rebuild; keep the
  edge-anchored restore for the rare rebuild that still happens.
- Keep existing behaviour for explicit user actions: timeframe switch, range
  menu, pattern focus jump, Alt+H reset, jump-to-latest.

## Validation
- Open an intraday chart during the session, zoom into ~1 hour, and wait through
  several quote ticks and at least one new bar: the visible range does not move.
- Scroll back two sessions and idle 30s: no snap-back; "jump to latest" still
  returns to the live edge.
- Wheel-zoom continuously for a few seconds: the gesture is never interrupted;
  the bar under the cursor stays under the cursor.
- Switch 5m → 1D → 5m: each opens on its default window.

## Technical files
- `src/components/market/CandleChart.tsx` — effect split, value-based deps,
  separate price-line effect, gesture guard, single range application.
- `src/routes/market/Analysis.tsx` — stabilise `priceLines` (value-keyed memo)
  so the chart props stop changing every tick.
- `src/routes/market/IndexDetail.tsx` — same treatment for props passed there.
