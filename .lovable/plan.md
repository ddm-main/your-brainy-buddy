
# Chart workbench — bug list + hardening plan

Scope: `src/components/market/{CandleChart,ChartToolbar,ChartLegend,TradingViewChart,FullscreenShell,IndicatorSettingsModal}.tsx`, `src/routes/market/Analysis.tsx`, `src/lib/market/indicatorRegistry.ts`.

## A. Bugs (functional / correctness)

1. **Settings menu is decorative.** `settings.logScale`, `grid`, `priceLine`, `sessionBreaks` are persisted but never applied to the chart. Toggling changes nothing.
2. **TV mode ignores exchange toggle.** `Analysis.tsx` calls `<TradingViewChart symbol={sym} … />` without `exchange`, so the widget hardcodes BSE even when the user picks NSE in the header.
3. **Chart rebuilds on every parent re-render.** `useEffect` deps include `computed` (new array identity every render) → full `chart.remove()` + rebuild on any Analysis re-render (quote tick, sector fetch, etc.). Kills perf and flickers legends/markers.
4. **Live tick doesn't update volume.** `livePrice` effect keeps `base.volume` constant and never touches the volume histogram series; the volume bar stays frozen between refetches.
5. **`INTRADAY_TFS` is stale.** Contains `3m/30m/2h/4h` — timeframes the toolbar removed. `intraday` prop can never be true for `30m/2h` because they're unreachable, and any saved layout with those TFs hits an unhandled state.
6. **Volume duplicated in three places.** Right-axis last value + top-left `V …` in OHLC bar + `Volume` legend row all show the same number. And Volume is registered as `group: "overlay"` in `indicatorRegistry` but rendered in its own pane — the `for` loop `break`s after the first volume study, so adding a second silently no-ops.
7. **Supertrend markers leak.** `markersPlugin` is reassigned inside the `for` loop; only the last plugin is detached on cleanup. Multiple Supertrend studies leave orphan plugins.
8. **Ichimoku cloud isn't forward-projected.** Span A/B are offset by `base` bars into indices that don't exist in `data`, so the last `base` points get dropped instead of drawn in the future. TradingView renders them ahead of the last bar.
9. **VWAP silently vanishes on daily+ TFs.** Correct to hide it, but the picker still lets the user add it and the settings modal opens on a study that draws nothing. No user feedback.
10. **`studyCount` label is misleading.** Toolbar shows visible count only; users with hidden studies see "Indicators 2" while 5 exist. Should be `visible/total`.
11. **`normalizeStudy` doesn't clamp params.** A saved layout with `period: -5` or `10000` survives; only `computeStudy` clamps at compute time (and only for known keys).
12. **Layout save uses `window.prompt`.** Blocking dialog, no HUD styling, silently overwrites an existing name with no confirm.
13. **Reset indicators uses `window.confirm`.** Same UX inconsistency; should be a HudModal confirm.
14. **`priceSeries` `priceLineVisible` is default-true** but `settings.priceLine=false` doesn't propagate.
15. **Screenshot loses DOM overlays.** OHLC top-left bar and `ChartLegend` are HTML, not canvas — export only contains canvas layers + the appended stamp; user sees a chart without indicator labels/values.
16. **F-key handler races with fullscreen.** `Analysis` listens for F to enter; `FullscreenShell` listens for F to exit. Both are active in fullscreen — Analysis guards with `if (fs) return;`, but the guard reads a captured value from a stale closure until re-subscribe. Should use a single owner.
17. **Chart type `bars` missing from picker.** `ChartType` union includes `"bars"` and CandleChart supports it, but `CHART_TYPES` in the toolbar only lists candles/line/area. Saved layouts with `bars` render but user can't select it.
18. **Alerts button shows no count** of existing alerts and doesn't draw alert prices as chart price lines (support/resistance are drawn, alerts aren't).

## B. Duplicates to remove

- **Volume triple readout** (§A6): keep it in the pane's right-axis, drop the `V …` from the top-left OHLC bar and the `Volume` legend row (or vice versa — pick one canonical location; industry standard is right-axis + legend, not OHLC bar).
- **INTRADAY_TFS ↔ TIMEFRAMES divergence** (§A5): single source of truth in `ChartToolbar` exporting the list + an `isIntraday(tf)` helper Analysis imports.
- **F-key handling** (§A16): FullscreenShell owns exit; Analysis only handles enter. Add a `fs`-scoped early return before subscribing.
- **`markersPlugin` per-loop reassignment** (§A7): collect into an array, detach all on cleanup.

## C. Industry-standard improvements

- **Wire the Settings menu**: `logScale` → `rightPriceScale.mode = PriceScaleMode.Logarithmic`; `grid` → `grid.{vert,horz}Lines.visible`; `priceLine` → `priceSeries.applyOptions({ priceLineVisible })`; `sessionBreaks` → `timeScale.applyOptions({ ticksVisible: !sessionBreaks })` (approximation LWC allows).
- **Chart engine correctness**: memoise `computed` at Analysis level OR split effect — one that creates the chart (deps: `chartType`, `fill`, `height`), another that updates candles/studies via `series.setData/update`. Eliminates rebuild-on-tick.
- **TV exchange parity**: pass `exchange` into `TradingViewChart`; keep BSE default only when unknown.
- **Bars chart type** re-exposed in picker with icon.
- **Studies indicator label**: `Indicators 3/5`.
- **Layouts UX**: replace `prompt`/`confirm` with `HudModal` prompt + overwrite confirmation; expose "Rename" and show updated timestamp.
- **VWAP guard in picker**: disable the VWAP entry on daily+ TFs with a tooltip "intraday only".
- **Ichimoku cloud**: append `base` synthetic future timestamps (last time + i·bar-spacing) as whitespace so span A/B render ahead of the last bar.
- **Alert overlay**: render active alerts (from `useStockAlerts`) as dashed price lines with tone by direction; show badge count on the Alert button.
- **Live volume tick**: accept `liveVolume` prop; when present, `volumeSeries.update({ … , value: liveVolume })`.
- **Keyboard shortcuts**: `S` screenshot, `Alt+1..7` TF, `I` opens indicators — mirrors TV.
- **normalizeStudy** clamps every param to `def.params[k].{min,max}` and snaps to step.

## D. Delivery order (single PR)

1. Registry + toolbar changes (bars type re-exposed, VWAP disabled off-intraday, `isIntraday` helper, TIMEFRAMES source-of-truth, layout HudModal prompt, indicator count `n/m`, alert count badge, keyboard shortcuts).
2. `CandleChart` split effects (create vs update), wire settings (grid/log/priceLine/sessionBreaks), fix markers leak, fix Ichimoku forward-projection, live volume, drop duplicate `V` from OHLC bar and `Volume` legend row.
3. `Analysis.tsx` — pass `exchange` to `TradingViewChart`, use `isIntraday`, add `liveVolume`, remove stale `INTRADAY_TFS`, add alerts price-lines, single-owner F-key, reset/layout modals.
4. `normalizeStudy` clamps + tests in `tests/marketIndicators.test.ts` for clamp + Ichimoku forward-projection.
5. Screenshot: dom-to-image composite of overlays (OHLC + legend) before canvas draw so exports include them.

No changes to indicator math (`chartIndicators.ts`) or backend edge functions.
