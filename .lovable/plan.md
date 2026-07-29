
# Charts Deep-Audit — Findings & Improvements

Scope covered: every chart surface in the app and the shared engine.

- Price/candle charts: `src/routes/market/Analysis.tsx`, `src/routes/market/IndexDetail.tsx`
- Chart engine + toolbar: `src/components/market/CandleChart.tsx` (930 lines, lightweight-charts), `ChartToolbar.tsx`, `ChartLegend.tsx`, `IndicatorSettingsModal.tsx`, `FullscreenShell.tsx`
- Indicator library: `src/lib/market/chartIndicators.ts`, `indicatorRegistry.ts` (~35 studies)
- Candle data pipeline: `src/lib/market/hooks.ts` (`useCandles`), `liveSnapshot.ts`, `supabase/functions/market-candles/index.ts`
- HUD mini-charts (non-trading): `src/components/hud/HudChart.tsx` used by `PortfolioAllocation`, `Investments`

Benchmarks: TradingView, Zerodha Kite, Upstox Pro, Dhan, Fyers, Thinkorswim.

---

## A. Layout & workbench (vs TV / Kite / TOS)

1. **Chart is a panel, not the workbench.** `mk-anl-grid` renders chart as one of two columns with a scrolling right rail — industry norm is chart-owns-viewport with collapsible rails and a bottom pane for orders/positions.
2. **No left drawing toolbar.** TradingView/Kite/Dhan all pin trendline, ray, horizontal, Fib, rectangle, brush, measure, magnet, lock, hide-all, delete-all on a fixed left rail. We have none.
3. **No bottom pane for orders/positions/trades tied to symbol.** Analysis rail carries fundamentals/news, but no order-book/tape/positions strip under the chart.
4. **No multi-chart layouts** (1×1 / 2×1 / 2×2 / grid) and no linked crosshair/time-sync/symbol-sync across panes.
5. **No compare/overlay another symbol** on the same chart (Kite has this; TV standard). Registry has no compare series.
6. **Fullscreen shell is minimal** (`FullscreenShell.tsx` 69 lines): no in-fullscreen symbol search, TF buttons, or provider status; viewport/crosshair not preserved.
7. **Two disconnected chart hosts.** `Analysis.tsx` and `IndexDetail.tsx` each maintain their own `tf/chartType/studies/settings/persistence` — logic drift risk. Should share a `<ChartWorkbench>` container.
8. **Mobile chart is not chart-first.** Responsive CSS just stacks the rail; needs a mobile chart mode with bottom sheets.

## B. Toolbar & interval controls

9. **Intervals hidden behind a menu** (`ChartToolbar.tsx:123-133`). Industry standard is inline segmented buttons: `1m 5m 15m 1h 1D 1W 1M` + a "more" menu — one click switch, keyboard `,` `.` navigation.
10. **Only 7 timeframes**; missing 3m/30m/2h/4h and any tick/seconds bars. Backend was trimmed but power users expect at least 3m/30m/2h.
11. **No keyboard shortcuts** at all (TV: `Alt+T` trendline, `Alt+H` horizontal, `,` `.` TF, `Shift+F` fullscreen, etc.).
12. **Toolbar is a bordered strip separated from chart canvas** (`.mk-chart-toolbar` in `styles.css`) — steals vertical chart space; should be a slim chart-header row like TV.
13. **Chart type list is thin** — no Heikin-Ashi, Hollow candles, Renko, Kagi, Line-break, Point-and-figure, Baseline (TV/TOS staples).
14. **Layouts save `tf/chartType/studies/settings` to localStorage only** — no cross-device sync, no default-layout-per-symbol, no template share.
15. **Alerts are only a modal launcher** — chart doesn't render alert lines, no drag-to-set-price, no right-click "Add alert here".
16. **"Screenshot" is a manual canvas composite** (`Analysis.tsx:212`) — drops legends, degraded ribbon, drawings, watermark.

## C. Rendering, price axis, crosshair

17. **Crosshair legend is basic** (`ChartLegend.tsx`) — no OHLC + %change + volume + spread row pinned at top-left the way TV does. No pinned/floating snapshot on click.
18. **Price scale defaults are hard-coded**; no per-scale options: auto-scale, invert, percent, log, indexed-to-100, right/left/both scales, price scale margins UI.
19. **Time scale**: no time-zone selector, session times, weekend hide toggle, or extended-hours shading; `sessionBreaks` is a boolean.
20. **No price scale labels for live LTP, bid/ask, prev close, day high/low** floating on the right axis (TV/Kite render these constantly).
21. **Colors are hard-coded** (`UP = "#6bffb0"`, `DOWN = "#ff5f6d"`) — violates project token rule; no theming, wick/candle body/volume palette locked.
22. **No trade markers** on chart from user's executed orders/holdings (TV/Kite plot buys/sells inline).
23. **No corporate-action markers** (splits, dividends, bonuses) — data is fetched (`useCorporateActions`) but never drawn.
24. **Volume pane is hidden when all volumes are zero** (`CandleChart.tsx:593`) — silently misleading for quote-seeded/delayed bars.
25. **No volume profile / VWAP-anchored / session-VWAP / VbP** studies.
26. **No cursor tooltip lag or throttling** control; on large series performance can drop — no downsampling for `>N` bars.

## D. Indicators

27. **35 indicators, but no folder/category tree** in registry beyond overlay/oscillator; no favorites, no recently used.
28. **No indicator templates** ("Trend", "Momentum", "Volume", "Breakout") applying multiple studies at once.
29. **No study-on-study inputs** (e.g., RSI of EMA, MACD of source=hl2 is limited).
30. **`IndicatorSettingsModal` is a modal** — TV uses a lightweight settings popover on click; modal breaks flow.
31. **No study visibility persistence per symbol** for hidden state (only whole study list).
32. **No color palette per study** with theme awareness; each study stores raw hex.
33. **Missing common studies**: Volume Profile (fixed range/visible/session), Anchored VWAP, Fibonacci-based tools (retracement/extension/timezone) as drawings, Pivot Points (Classic/Camarilla/Woodie/Fibonacci), Squeeze Momentum, Elder Impulse.

## E. Drawing tools

34. **Zero drawing tools.** No trendline, ray, extended line, horizontal/vertical, rectangle, ellipse, arrow, callout, price range, date range, Fibonacci family, Gann, Elliott, brush, path.
35. **No drawing persistence** per symbol/timeframe.
36. **No object tree / drawings panel / lock / hide / delete-all**.
37. **No snap-to-price, magnet-strong, or ray extend controls** for drawings (magnet toggle exists but only for crosshair).

## F. Data pipeline & live behavior (chart data reliability)

38. **`useCandles` backs off to 5m during outage** (`hooks.ts:503`) — recovery lag.
39. **Route breaker state is per-isolate** (`routeBreaker.ts`) — Supabase edge cold starts lose it; user sees inconsistent fallback.
40. **Cache misses for quote-seeded bars** (`market-candles/index.ts:452-468` only persists Kotak bars) — repeated outages never build usable history.
41. **Response provider is scalar** (`types.ts:220-243`) — cannot express mixed source (history=cache + last-bar=quote). No per-bar/segment provenance.
42. **No `as_of / last_bar_at / server_time / freshness_ms / is_realtime / market_session`** in the response — UI infers freshness.
43. **`allow_delayed_intraday` pref exists in DB but is unused** — users must toggle per symbol.
44. **NSE session gate is time-based, not calendar-aware** — holidays trigger wrong live-only fallback rules.
45. **`livePrice`/`liveVolume` overlay in Analysis** re-prices last bar but treats daily "live" too generously — should label as "EOD + live LTP overlay".
46. **`IndexDetail` chart has no live-price overlay** (`useCandles(symbol, tf, "NSE")` only) — index charts stall between polls even when a live quote exists.

## G. Trade-from-chart / alerts / orders

47. **No draggable alert horizontal lines**; alerts exist but are external.
48. **No draggable order lines** (limit/stop) or right-click "Buy here / Sell here / Alert here" context menu (Kite `t → o` style shortcuts).
49. **No position/PNL overlay** — holdings/positions API is not wired into the chart.

## H. Non-trading HUD charts (`HudChart.tsx`)

50. **Hand-rolled SVG only** — bar/line/donut with no legend interactivity, no tooltip, no axis, no responsive sizing beyond `width` prop; used by `PortfolioAllocation` and `Investments` which deserve tooltips/hover values.
51. **Line chart requires ≥2 points**; empty-state hint only ("not enough data"), no skeleton.
52. **Colors palette hard-coded** (`PALETTE`) — bypasses tokens.

## I. Accessibility, consistency, code health

53. **Raw `<button>` styling in chart UI** (`ChartToolbar.tsx:182, 196, 321`, `Analysis.tsx:546`) — bypasses design system buttons, inconsistent focus/aria.
54. **Inline styles pervasive** in `Analysis.tsx:462-588`, `ChartToolbar.tsx`, `FullscreenShell.tsx`.
55. **No aria-labels for icon-only chart controls**; keyboard focus order not verified.
56. **Two persistence stores** (global localStorage + per-symbol) can drift.
57. **`Analysis` and `IndexDetail` duplicate ~150 lines** of chart-host code (studies/settings/layout/persist) — extract a `useChartWorkbench` hook + shared `<ChartWorkbench>` shell.

---

## Priority-ordered improvement list

**P0 — reliability & correctness**
- Segment-level provenance in `CandlesResponse`; add `as_of`, `last_bar_at`, `freshness_ms`, `market_session`.
- Persist quote-seeded/delayed bars with `source` column; expose per-bar/segment.
- Move route health to a shared table (survives isolate cold starts); NSE holiday calendar.
- Reduce `useCandles` backoff; reset on retry; hydrate `allow_delayed_intraday` from `market_user_prefs`.
- Show OHLC/volume/change header + accurate "history vs last bar" source in chart.

**P1 — industry-standard chart UX**
- Inline segmented timeframe bar + keyboard shortcuts; add Heikin-Ashi & Baseline; more chart types.
- Slim in-canvas chart header (symbol, OHLC, provider chip, TF, chart type, indicators, alerts, settings, fullscreen).
- Left drawing toolbar: trendline, ray, horizontal/vertical, rectangle, Fib retracement/extension, arrow, brush, measure, magnet, delete-all; persist per symbol/tf.
- Draggable alert & order lines; right-click chart context menu.
- Compare symbol overlay; corporate-action & user-trade markers.
- Full-featured price scale (log/percent/indexed/invert) and time scale (session/tz/extended hours).
- Extract shared `<ChartWorkbench>` used by Analysis + IndexDetail.
- Rewrite screenshot via DOM-to-image with watermark, legend, drawings, provenance.
- Move all colors to semantic CSS tokens; theme-aware.

**P2 — pro tooling**
- Multi-chart layouts (1/2/4) with linked crosshair/time/symbol.
- Templates & favorite indicators; on-canvas settings popover; Volume Profile, Anchored VWAP, Pivots.
- Cloud-synced layouts/drawings (per-user Supabase table).
- Fullscreen workbench with symbol search, TF, provider, alert/order buttons.
- Mobile chart-first view with bottom sheets & sticky TF row.

**P3 — housekeeping**
- Replace raw buttons with design-system controls; add aria-labels.
- Move inline styles to semantic classes.
- Add tooltips/hover to `HudChart` mini-charts; tokenize palette.
- Consolidate per-symbol/global persistence into one migration-safe store.

## Deliverable of this audit

Above is the finding list; no code has been changed. On approval, work should start with **P0 data-reliability track** and **P1 shared `<ChartWorkbench>` + drawing tools + inline TF + in-canvas header**, since every other improvement depends on those foundations.
