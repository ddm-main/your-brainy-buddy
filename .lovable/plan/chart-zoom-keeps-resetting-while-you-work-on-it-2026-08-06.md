# Chart zoom keeps resetting while you work on it

## Confirmed causes (read from `src/components/market/CandleChart.tsx`)

1. **The chart is still fully torn down and rebuilt whenever bar structure changes.**
   The structural gate (line ~430) bumps `renderTick` whenever bar count, first bar
   time, last bar time or the studies signature change, and `renderTick` is a
   dependency of the giant create effect (line 1302) whose cleanup calls
   `chart.remove()`. On an intraday rolling window every poll appends a bar and
   trims the oldest one, so the key changes and the whole chart — series, panes,
   primitives, subscriptions — is recreated repeatedly while you are working on it.

2. **A rebuild that lands near a gesture applies no range at all.**
   In `applyRange()` (line ~1212) the first line is
   `if (sameIdentity && isInteracting()) return;`. On a freshly created chart that
   means no viewport is set, so lightweight-charts shows its own default frame —
   which is exactly the zoomed-out view in the screenshot. The 350ms interaction
   window plus the 400ms deferred retry make this hit often during continuous
   wheel/drag work.

3. **The deferred rebuild retry can still fire mid-gesture.** `setDeferTick` after
   400ms re-runs the gate; if the user is still interacting it defers again, but
   once the timer lands in a gap the teardown happens under the cursor and the
   in-flight zoom is lost.

Everything else (edge-anchored restore, follow-live tracking, price lines applied
without rebuild, time-scale options) is already correct — the remaining problem is
the teardown churn and the "skip the range entirely" branch.

## Fix plan

### A. Update data in place; never rebuild on a data change
- Split the create effect into:
  - **create effect** — chart, series, panes, primitives, subscriptions — keyed on
    identity only (`viewportKey`, `chartType`, log scale, settings, studies *set*,
    intraday, fill/height, pane reset token).
  - **data effect** — on every candle/indicator change call `setData(...)` on the
    existing price series, volume series and each study series, and re-attach
    primitives' data (volume profile, markers) rather than recreating them.
- Keep series handles in a ref map keyed by study id so the data effect can find
  them. Adding/removing a study still recreates (identity change).
- Result: appended, trimmed or revalued bars never touch the viewport, because
  lightweight-charts preserves the visible logical range across `setData`.

### B. Rebuild never leaves the chart un-framed
- Remove the early `return` from `applyRange()`. On a brand-new chart the range
  must always be applied; the gesture guard only suppresses *re-framing an
  existing* chart. Track "chart was just created" and apply the stored edge
  anchor unconditionally in that case.
- Keep the single application pass on unchanged identity, and the extra
  post-layout pass only on identity change.

### C. Gesture safety
- Widen the interaction window to ~600ms and include `pointermove` while a
  pointer is down, so a slow drag never reads as idle.
- Any rebuild that must still happen (identity change) restores the edge-anchored
  range; data-only changes no longer rebuild at all, so the deferred-rebuild
  timer becomes a rare path.

### D. Default framing stays exactly as today
- Default window is applied only on a genuine identity change: symbol/exchange,
  timeframe, chart type, price scale, or a fresh mount (page refresh).
- Explicit user actions keep their current behaviour: timeframe buttons, range
  menu, pattern focus jump, Alt+H reset, "Latest" jump-to-live-edge.

## Validation
- Intraday 5m during the session: zoom into ~1 hour and hold; wait through several
  quote ticks and at least two new bars — the visible range does not move.
- Wheel-zoom continuously for 5+ seconds: no interruption, no snap-back, the bar
  under the cursor stays under the cursor.
- Pan back two sessions and idle 60s: view holds; "Latest" returns to the live edge.
- Switch 5m → 1D → 5m and reload the page: each opens on its default window.
- Toggle an indicator on/off: chart re-creates once and restores the same viewport.

## Technical files
- `src/components/market/CandleChart.tsx` — split create/data effects, series-handle
  refs, unconditional range application on creation, widened gesture guard.
