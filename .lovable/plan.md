## Goal
Fix the Analysis workbench end-to-end and rebuild its chart controls as a real TradingView-style dropdown toolbar. Verified against the live app while logged in — the issues below were reproduced with screenshots, not guessed.

## Bugs verified (with reproduction)

### Right rail — panels are stacking on top of each other (root cause)
Screenshot `/market/analysis/RELIANCE` at 1332×892: `A1 QUOTE`, `A2 BREAKOUT`, `A3 INDICATORS`, `A4 RANGE`, `A5 AI VERDICT`, `A6 FUNDAMENTALS` all render on top of one another with visible text bleed-through.

Root cause: `HudPanel` renders a `<section>` with `display:flex; flexDirection:column; minHeight:0` and no `flex` value. Inside a flex-column parent (the right rail: `display:flex; flexDirection:column; gap:12; overflowY:auto`), the default `flex:0 1 auto` combined with `min-height:0` lets every panel shrink below its content height. Result: panels collapse and their content overflows into the next panel's box (visible in every screenshot I captured, including the TradingView-mode view).

Fix: give the panel root `flex: 0 0 auto` (or drop `min-height:0` on `flow` panels). This is a single-line change in `src/components/hud/HudPanel.tsx` and it also unblocks the rail's `overflow-y:auto` scroll.

### Chart toolbar overflows and wraps
Selected-element text and screenshots show the header row wrapping into two lines at 1332px and into three lines at 1100px (`1D 1H 15M 5M / CANDLES BARS LINE AREA / TRADINGVIEW ⛶`), then the 9 indicator chips wrap into another two lines below. The panel title `MK.ANL · RELIANCE · 1D` also cramps into that row. The vertical `<span>` dividers between button groups render at height 0 because they have `width:1` but no `height`.

### Native chart body is blank
In the 1D view for RELIANCE the OHLC legend renders (`O 1535.20 H 1551.50 …`) but no candles are drawn — the chart body area is empty. TradingView mode on the same symbol shows a full candle chart, so data + rendering pipeline work in the TV path but not the native `CandleChart` path. Likely causes to verify in the fix pass:
- `CandleChart` receives `fill` and sizes off `container.clientHeight`, but the panel body is inside a `FullscreenShell` whose flex parent may report height 0 on first paint (no ResizeObserver-driven resize).
- Or the `candles` array is arriving with string timestamps that `lightweight-charts` rejects silently.

Diagnosis and fix belong in the same pass because a broken primary chart is the highest-priority bug.

### Right-rail responsiveness
At 1100px the rail is still pinned to a fixed 300px column, so the chart column shrinks to ~750px, indicator chips wrap to three rows, and the panels overlap even harder. Below ~1000px the layout is unusable.

### Section index labels
`A1 A2 A3 A4 A5 A6` but `Market Depth` currently uses `A1.5` (out of sequence) — cosmetic.

### AI Verdict inner layout
The Entry/Stop/T1/T2/Hold block wraps a `1fr 1fr` grid around `Row` components that are themselves two-column, so numbers overflow the 300px rail and land under the rationale text.

### Market Depth alignment
Qty column is not right-aligned and long numbers (`26,40,042`) collide with the price column in the ask half.

## Changes (scope: Analysis UI + one HudPanel line + one CSS block)

### 1. Fix panel collapse (unblocks everything else)
`src/components/hud/HudPanel.tsx` — add `flex: "0 0 auto"` to the section root style. This is the only change to `HudPanel` and it doesn't affect the fixed-height chart panel (which already sets `flex: 1` via its `style` prop).

### 2. Fix native chart rendering
`src/components/market/CandleChart.tsx`:
- Guarantee the chart resizes after mount by observing the container with `ResizeObserver` and calling `chart.applyOptions({ width, height })` on every entry. Also call `chart.timeScale().fitContent()` after the first series `setData`.
- Coerce `time` values: if `typeof time === 'string'` and the string is `YYYY-MM-DD`, pass it through unchanged (lightweight-charts accepts BusinessDay strings); if it's an ISO datetime, convert to a UNIX second `UTCTimestamp`. Guard against `NaN`/`null`.

If after the fix the chart is still blank the diagnosis will surface (via a one-line dev warning we'll add for empty series) instead of failing silently.

### 3. New TradingView-style toolbar
Replace the wrapping `actions` row + indicator-chip strip with a single compact toolbar rendered inside the chart panel body (above the chart, not in the header). It has real dropdown menus:

```
[1D ▾]  [Candles ▾]  [ƒ Indicators ▾]  [🔔 Alert]  [⧉ Layout ▾]  [⋯ More ▾]        [TV | Native]  [⛶]
```

- **Interval ▾** — 5m / 15m / 1h / 1D (existing `TIMEFRAMES`). Selected row shows check.
- **Chart type ▾** — Candles / Bars / Line / Area (existing `CHART_TYPES`), disabled while `TV` mode is on.
- **Indicators ▾** — grouped checkbox menu: *Overlays* (EMA20/50/200, SMA20, BB, VWAP) / *Oscillators* (RSI, MACD) / *Volume*. Persists to `IND_STORE` as today.
- **Alert** — navigates to `/market/alerts?symbol=<sym>` (existing route).
- **Layout ▾** — Single (active), 2-up / 2×2 (disabled, "coming soon"). Ships as visual parity with TradingView; no behavior change.
- **More ▾** — Reset indicators, Open in TradingView (external), Fullscreen.
- **TV | Native** — segmented switch (replaces standalone "TradingView" button).
- **⛶** — fullscreen icon.

New files:
- `src/components/hud/Menu.tsx` — tiny popover primitive: button + absolute-positioned panel, close on outside click / `Escape` / route change. No new dependencies.
- `src/components/market/ChartToolbar.tsx` — owns the menu wiring; state stays in `Analysis.tsx`.

`src/routes/market/Analysis.tsx`:
- Remove the wrapping button row from panel `actions` (leave only the segmented TV/Native + fullscreen icon).
- Remove the standalone indicator-chip strip; move indicators into the dropdown.
- Move `MK.ANL · RELIANCE · 1D` header text to just `RELIANCE` (interval/type live in the toolbar).

### 4. Rail layout polish
`src/routes/market/Analysis.tsx` + a small CSS block in `src/styles.css`:
- Add `.mk-anl-grid` with `grid-template-columns: minmax(0,1fr) minmax(280px,340px)`; at `max-width: 1100px` collapse to a single column (rail below chart).
- Increase rail `gap` to `16px`; add `padding-right: 4px` so the panels' outer glow shadows don't clip against the scrollbar.
- `Market Depth` inner grid → `grid-template-columns: auto 1fr` with `text-align:right` on qty.
- `AI Verdict` — drop the nested `1fr 1fr` grid; render Entry/Stop/T1/T2/Hold as stacked `Row`s.
- Renumber index labels to `A1..A7` (Depth becomes A2, everything after shifts).

### 5. Small polish
- Restore visible group dividers in the toolbar (`width:1; align-self:stretch; background:var(--edge)`).
- All toolbar controls close on `Escape` (reuses `useEscapeClose`).

## Files touched

- `src/components/hud/HudPanel.tsx` — one-line flex fix.
- `src/components/hud/Menu.tsx` — new popover primitive.
- `src/components/market/CandleChart.tsx` — ResizeObserver + time coercion + `fitContent()`.
- `src/components/market/ChartToolbar.tsx` — new toolbar with dropdowns.
- `src/routes/market/Analysis.tsx` — wire toolbar, drop old rows, renumber, responsive grid, fix Depth + AI Verdict panels.
- `src/styles.css` — `.mk-anl-grid` responsive rules + tiny `.mk-menu` styles.

## Out of scope (flagged as follow-ups, not built in this pass)

- Symbol search inside the toolbar (needs an autocomplete hook against `market_stocks`).
- Real multi-chart split layouts (2-up, 2×2) — Layout menu ships as stub.
- Drawing tools (trendlines, fibs, measure) on the native chart — requires lightweight-charts drawing primitives.
- Server-persisted indicator/layout presets per symbol (today: localStorage global).
- Auditing the wider Market section (Options, Positions, Watchlists) for the same `HudPanel` collapse — the fix to `HudPanel` will help globally, but a follow-up sweep is worth scheduling if any other page uses `flow` panels in a flex column.

## Verification plan

After the fix, re-run the same logged-in Playwright script at 1332×892, 1100×800, and 900×800, and confirm:
- No panel overlap in the right rail; each panel renders its full content and the rail scrolls.
- Native chart renders candles for RELIANCE, AIIL, and a small-cap symbol.
- Toolbar fits on a single row down to 900px; dropdowns open, close on outside click and `Escape`, and persist indicator toggles across reload.
- TV mode still works and no longer has the standalone TradingView button in the header.
