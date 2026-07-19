## Audit results — Stock Analysis workbench

I inspected `src/routes/market/Analysis.tsx`, `ChartToolbar.tsx`, `FullscreenShell.tsx`, `HudPanel.tsx`, and the `.mk-anl-*` / `.hud-panel` CSS. Here is what is already shipped from the earlier plan, what's still broken, and what I'll fix in this turn.

### Already shipped
- TradingView-style toolbar shell with dropdown menus (Interval, Chart type, Indicators, Layout, More) via `Menu`.
- Native ↔ TV segmented toggle, Alert button, "Open in tradingview.com" link.
- Indicator flags persisted to `localStorage`.
- Right rail is a flex-column with `gap: 14px`, panels use `flow` (content-sized).
- `FullscreenShell` portals to `document.body` with `zIndex: 300` and Esc-to-exit.

### Bugs I confirmed
1. **Right rail panels overlap (image 8 & 10).** `HudPanel` renders decorative `::before`/`::after` layers and 4 absolute `.hud-corner` spans with `overflow: hidden` on the outer section — but when `flow` is on, we set `overflow: visible` on both wrapper and body, so on Chromium the shimmer layer occasionally paints outside and, more importantly, the body's inner flex column collapses because `flex: 0 0 auto` combined with an unbounded `min-height:0` lets Rows render before the header measures, producing visible overlap on first paint and on updates (AI Verdict re-render triggers it every 6h refresh).
2. **Rail width too narrow** — `minmax(280px, 340px)` at typical viewport gives ~300px; the header text ("BREAKOUT INTELLIGENCE", "INDICATORS (DAILY)") wraps behind adjacent index labels.
3. **Fullscreen bleeds through** — `zIndex: 300` sits under the app TopBar/AmbientLayer (they use z-index 400+). The user sees the top bar and ambient scanlines drawn on top of the fullscreen chart.
4. **Fullscreen body doesn't clip** — `document.body.style.overflow="hidden"` only; the root app container keeps its own scroll and the ambient canvas keeps painting.
5. **Toolbar wraps to two rows** on narrow widths and the segmented Native/TV control jumps to a new line, hiding the fullscreen icon.
6. **Chart type dropdown disabled in TV mode** but the disabled state has no visible cue on the trigger button beyond `opacity`.
7. **Interval set is thin** — only 5m/15m/1h/1D. TradingView parity needs 1m/3m/5m/15m/30m/1h/2h/4h/1D/1W/1M and quick range buttons (1D/5D/1M/3M/6M/YTD/1Y/5Y/All).
8. **No left drawing rail** (cursor/trend/hline/text/measure) — currently only inside TV embed.
9. **`onTvMode` toggle races** — flipping to TV then back to Native re-mounts `CandleChart` without preserving the previous crosshair/zoom.
10. **Alert button** navigates away instead of opening a lightweight modal, breaking the "TradingView-like" feel.

### Plan — what I will build

**A. Right rail overlap fix**
- Widen rail to `minmax(320px, 380px)` and bump gap to 12px.
- On `HudPanel` in `flow` mode: switch outer `overflow` to `hidden` (keeps shimmer contained) but keep body `overflow: visible`; set body `min-height: auto` so content measures before layout.
- Remove `::after` shimmer on flow panels (add `.hud-panel[data-flow="true"]::after { display:none }`) — it's the layer bleeding on re-renders.
- Header gets `flex-wrap: nowrap` with `min-width:0` and `text-overflow: ellipsis` on the title so index chip never sits over the label.

**B. Fullscreen overlay fix**
- Raise `FullscreenShell` z-index to `9999`.
- Add `document.documentElement.style.overflow="hidden"` alongside body, and toggle a `body.is-fs-chart` class that hides `.hud-topbar`, `.ambient-layer`, and the router shell via CSS while active.
- Give the overlay its own solid background (`var(--bg)`) plus a `backdrop-filter: blur(2px)` fallback so nothing bleeds through if a portal fails.
- Make the exit button larger (44px tap) and add an "F" shortcut in addition to Esc.

**C. TradingView-parity toolbar**
- Expand intervals to 1m/3m/5m/15m/30m/1h/2h/4h/1D/1W/1M with a "Seconds" submenu placeholder.
- Add **Range** dropdown (1D/5D/1M/3M/6M/YTD/1Y/5Y/All) that maps to candle window (separate from interval).
- Add **Compare** dropdown (NIFTY/BANKNIFTY/sector index + custom) — overlays a normalized line on `CandleChart`.
- Add **Settings** dropdown (theme: dark/darker, grid on/off, log scale, price line, session breaks).
- Add **Save layout** action (persists tf + chartType + flags + compare list under `jarvis.analysis.layouts` and lists them under Layout menu).
- Add **Screenshot** action (uses `html-to-image` on the chart container, downloads PNG).
- Make Alert open a `HudModal` with price + condition (above/below) and call the existing alerts hook; no route change.
- Prevent wrap: set toolbar to `flex-wrap: nowrap; overflow-x: auto` on narrow, hiding scrollbar.
- Disabled state gets a visible strike style, not just opacity.

**D. Left drawing rail (native chart only)**
- New `ChartDrawingRail` component (vertical 36px strip) with: cursor, crosshair, trend line, horizontal line, vertical line, rectangle, text, measure, magnet, lock, clear-all.
- State stored per-symbol in `localStorage` (`jarvis.analysis.draw.<SYM>`).
- Wire into `CandleChart` via an overlay `<canvas>` sibling; drawings render on top and rescale with the price/time axes it already exposes.

**E. Persistence & UX polish**
- Persist `tf`, `chartType`, `tvMode`, `compare[]`, and the layout preset name in a single `jarvis.analysis.state` object.
- Preserve zoom when toggling Native↔TV by lifting `visibleRange` state into `Analysis.tsx`.
- Add symbol search box in top of toolbar (small autocomplete against `market_scrips`).
- Debounce indicator toggles so `CandleChart` doesn't recompute on each click.

### Technical notes
- Files touched: `src/routes/market/Analysis.tsx`, `src/components/market/ChartToolbar.tsx`, `src/components/market/FullscreenShell.tsx`, `src/components/market/CandleChart.tsx`, `src/components/hud/HudPanel.tsx`, `src/styles.css`. New: `src/components/market/ChartDrawingRail.tsx`, `src/components/market/AlertQuickModal.tsx`, `src/lib/market/chartLayout.ts`.
- No DB migrations, no edge-function changes.
- No new package needed except `html-to-image` (~7 kB) for screenshot; skip if you'd rather use native `canvas.toDataURL`.
- I'll verify by launching Playwright against `/market/analysis/FEDERALBNK` at 1574×997 and screenshotting: normal, dropdowns open, fullscreen, narrow (900px).

Approve and I'll ship all of A–E in one pass.