## Goal

Make `/market/index/:symbol` (Nifty 50, Bank Nifty, global indices) look and behave like the stock analysis page (`/market/analysis/:symbol`): a full-height chart on the left and a scrolling rail of readout panels on the right — instead of today's short stacked panels with a tab strip.

## Current state (verified)

- `src/routes/market/IndexDetail.tsx` renders a plain vertical stack: header panel with price + 4 tabs (chart / technicals / F&O / constituents), then one panel per tab. The chart is not viewport-height, and technicals/F&O/constituents are only reachable by switching tabs.
- `src/routes/market/Analysis.tsx` uses `.mk-anl-grid` (chart column + `.mk-anl-rail`, defined in `src/styles.css:1503-1525`, collapsing to one column under 1180px) with rail panels: Quote (A1), Alerts (A9), Depth, Breakout Intelligence (A3), Indicators Daily (A4), Range & Strength (A5), AI Verdict (A6).

## Layout to build

```text
+---------------------------- mk-idx-grid ----------------------------+
| MK.IDX.C  Chart (full height)              | A1 Quote               |
|  toolbar: 1D / candles / indicators /      |   price, +chg (chg%)   |
|  alert / layouts / settings / more         |   ^NSEI · IN · F&O     |
|                                            | A9 Alerts              |
|  candles + volume, fullscreen shell        | A4 Indicators (Daily)  |
|                                            | A5 Range & Strength    |
|                                            | A7 F&O Snapshot        |
+--------------------------------------------+------------------------+
| Wide tabs under chart: F&O chain | Constituents  (only when avail.)  |
+---------------------------------------------------------------------+
```

## Changes

1. **Restructure `IndexDetail.tsx`**
   - Replace the stacked wrapper with the grid used by Analysis (new `.mk-idx-grid` alias reusing the `.mk-anl-*` rules, or reuse `.mk-anl-grid`/`.mk-anl-rail` directly so responsive behaviour is identical).
   - Left column: single `HudPanel` (`MK.IDX.C`) with `flex: 1; minHeight: 0`, containing `FullscreenShell` + `ChartToolbar` + `CandleChart`, exactly like Analysis (chart fills the viewport, no longer a squat box).
   - Move the index name / back button into the chart panel header + rail Quote panel, dropping the separate tall header panel.

2. **Right rail panels** (reuse the existing `Row`/`Stat` helpers and `HudPanel flow`)
   - `A1 Quote`: big price, `Return1DCell` with abs + pct, symbol · region chips, F&O chip, provider/stale chip.
   - `A9 Alerts`: reuse `StockAlertsPanel` for the index symbol (currently the index page only has a "new alert" modal, no list).
   - `A4 Indicators (Daily)`: RSI / MACD / EMA20-50-200 / SMA20 / Bollinger / Volume / Avg Vol — computed from the same `TechnicalsPanel` stats memo, extracted into a reusable `useIndexTechnicals(candles)` hook.
   - `A5 Range & Strength`: Open / Prev close / Day H-L / Day change / 52W high-low / % from 52W high & low.
   - `A7 F&O Snapshot` (only when the index has F&O): Spot, PCR, total call/put OI, expiry from `useOptionChain`.

3. **Wide content below the chart**: keep a slim tab strip for the two table-shaped views that don't fit a 360px rail — **F&O option chain** and **Constituents** — rendered full width under the chart column, shown only when available (`fno && nseSymbol`, `cSlug`) and defaulting to Constituents for Indian indices, F&O chain otherwise. The old "technicals" tab disappears because its content now lives in the rail.

## Bug fixes found while auditing this page

- Index chart currently always requests exchange `"NSE"`; global indices (`^GSPC`, `^IXIC`) should not send an NSE exchange hint — pass exchange only for `region === "IN"`.
- `deriveChangeAbs` fallback isn't applied on the index header, so when the quote returns only `change_pct` the absolute value shows `—`; mirror the Analysis behaviour (`dayChange ?? deriveChangeAbs(price, pct)`).
- Chart layouts save (`handleSaveLayout`) has no load/delete counterpart on this page — wire `onLoadLayout` / `onDeleteLayout` / `savedLayouts` like Analysis so the Layouts menu isn't half-functional.
- `intraday` is never passed to `ChartToolbar` / `CandleChart` on this page, so intraday timeframes render with daily axis formatting — pass `isIntraday(tf)`.
- Unused imports left after the refactor (`ScoreBadge`, `useQuotes`, live tick helpers if unused) get cleaned up; verify with a typecheck/lint pass.

## Verification

- Typecheck + lint clean.
- Playwright screenshot of `/market/index/%5ENSEI` at 1576×997 (chart fills height, rail visible) and at ~1100px width (single-column stack).
- Check a global index (`^GSPC`) renders without F&O/Constituents tabs and without an NSE exchange hint.
