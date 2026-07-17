## Goal
Bring the Market section up to parity with Finance: horizontal top-level tabs (no left sidebar), all sub-pages actionable (no dead "Phase 2" scaffolds), and a cleanup pass on the bugs surfaced by the current screenshots and code review.

## 1. Navigation — mirror Finance

Rewrite `src/routes/Market.tsx`:
- Drop the 180px left sidebar.
- Add a horizontal top tab strip (same `tabBase` styling / `role="tablist"` pattern as `Finance.tsx`).
- Group tabs into 4 sections with an optional sub-tab strip:

```text
Overview     → /market                    (Dashboard)
Portfolio    → /market/holdings           subs: Holdings · Positions · Watchlist
Research     → /market/screener           subs: Screener · Analysis · Backtesting
Alerts       → /market/alerts
Settings     → /market/settings
```

- Keep every existing route path so bookmarks still work.
- Sync `document.title` per active group (copy the `useEffect` idiom from Finance).
- Keyboard arrow-nav on the sub-strip (reuse the `SubTabStrip` pattern verbatim).

## 2. Bugs to fix (visible in the screenshots)

| # | Bug | Fix |
|---|-----|-----|
| B1 | Left sidebar pushes content so HUD panel decorative "[" brackets on `MK.D2/D5/D6` panels clip off the left edge | Removed by switching to top-nav layout. Also normalize page container to `padding: 12` (matches Finance). |
| B2 | `Alerts.tsx` and `Backtesting.tsx` are one-line scaffolds — user sees only a "Pipeline pending" strap | Build real pages (see §3). |
| B3 | `Dashboard.tsx` calls `useQuery` for `watchSymbols` but returns full row — types typed as `any`; also fires an extra `useStockScores({ limit: 1000 })` just to intersect with watchlist. Wasteful | Move watch-pulse math into a single query that joins scores↔watchlist client-side using the already-fetched `topBreakouts`+`preBreakouts`, and drop the 1000-row fetch. |
| B4 | `Analysis.tsx` route param `:symbol` — when opened with no symbol shows empty state with no picker | Add a symbol search input that navigates to `/market/analysis/{sym}`. |
| B5 | `_Scaffold.tsx` still referenced by Alerts/Backtesting only — delete after §3. | |
| B6 | `Market.tsx` currently has no `document.title` update, no aria roles | Handled by §1 rewrite. |
| B7 | Sub-routes catch-all `Route path="*"` inside `<Routes>` uses `Navigate to="/market"` — fine, but nested `analysis/:symbol` order should stay before catch-all (already correct; keep). | |

## 3. Real Alerts & Backtesting pages

### Alerts (`/market/alerts`)
Reads existing `market_alerts` table (13 cols, already in schema). Ship a working CRUD UI:
- List active alerts (symbol, type, threshold, status, last triggered).
- "New alert" modal: symbol, type (price above/below, % move, RSI cross, EMA cross, breakout), value, notify via (browser/email).
- Toggle enabled/disabled, delete.
- Filter by symbol & type.
- No backend changes — use `supabase.from("market_alerts")` directly with RLS.

### Backtesting (`/market/backtesting`)
Reads `market_backtest_results` (already exists) and `market_saved_strategies`:
- Strategy picker (saved strategies list; if empty, show a "create simple strategy" form: symbol + rule set = EMA-cross / RSI-threshold / Breakout).
- Window selector: 1y / 3y / 5y / 10y.
- Run button → call `callMarketFn("market-backtest-run", …)` (new function — but out of scope; instead this iteration reads any existing rows from `market_backtest_results` and displays: win rate, profit factor, Sharpe, Sortino, max DD, equity curve chart via `CandleChart`-style `LineSeries`, monthly returns heatmap).
- If no results and no run function, show a clear "Run pipeline to compute" message with an inline button to trigger a stub call that logs "not implemented" — better than the current dead scaffold.

Note: full backtest engine is a bigger project; this scope delivers the UI + read of existing rows so the tab is no longer a dead end. Confirmed with user tolerance for placeholder run behavior if no engine exists — otherwise wire the run button to whatever function is available.

## 4. Small polish across existing Market pages

- `Dashboard.tsx`: Add a light empty state on `Sector Strength` and `Pre-Breakout Watch` that links to `/market/settings` when pipeline is empty (currently just static text).
- `Holdings/Positions/Watchlist/Screener/Analysis/Settings`: quick pass to (a) remove any horizontal overflow, (b) ensure the top-tab layout doesn't add double scroll, (c) keep 12px padding consistent with Finance.
- Delete `src/routes/market/_Scaffold.tsx`.

## Files touched

Frontend only. No schema, no edge-function changes.

- `src/routes/Market.tsx` — rewrite navigation
- `src/routes/market/Alerts.tsx` — real page
- `src/routes/market/Backtesting.tsx` — real page
- `src/routes/market/Dashboard.tsx` — drop 1000-row fetch, empty-state links
- `src/routes/market/Analysis.tsx` — symbol picker when no `:symbol`
- `src/routes/market/_Scaffold.tsx` — delete

## Out of scope

- New edge functions (backtest engine, alert delivery worker).
- Schema changes to `market_alerts` / `market_backtest_results`.
- Redesign of Dashboard's visual composition — layout stays, only nav chrome changes.
