
## Context

You referenced "the below plan" but nothing was pasted, so I'm working from the codebase (10 Market routes, ~2,500 lines, backed by `market-*` edge functions + `market_*` tables that already exist) and the visible symptom: `/market` renders blank in preview even though the code is substantial.

Since you skipped the clarifiers, defaults chosen:
- **Blank UI** = both — fix the runtime crash *and* enrich sparse panels.
- **Data source** = live via existing providers (Yahoo default, Kotak when connected) + seed a Nifty 50 / Bank Nifty / F&O stock universe into `market_stocks` so screener/analysis have symbols to work with out of the box.
- **Scope** = UI rewrite + fix broken edge functions + small DB migrations where required. No new cron/pipeline overhaul.

## Phase 0 — Diagnose the blank screen (must happen first)

Symptoms in edge-function logs: `market-indices` and `gmail-sync-due` boot but no request rows for `market-*` from the preview session → the client either isn't calling them or is crashing before render. Likely causes to verify with a Playwright run against `http://localhost:8080/market`:

1. Uncaught error in one of the lazy-loaded route components (React Query throws → no ErrorBoundary at the Market level → whole subtree unmounts blank).
2. `useIndices` failing because `market_breadth_daily` is empty → error propagates.
3. A schema drift in `market_stock_scores` after the recent audit changed columns.

**Deliverable:** wrap `<Routes>` in `src/routes/Market.tsx` with an `ErrorBoundary`, log the real error, capture a screenshot, then fix root cause.

## Phase 1 — Shared plumbing

- Add `<ErrorBoundary>` around the Suspense in `Market.tsx` with a HUD-styled fallback that shows the error message + a "Retry" button.
- Extend `src/lib/market/hooks.ts` with:
  - `useTopMovers()` (gainers/losers/most-active from `market_stock_scores`).
  - `useIndexConstituents(indexKey)` returning symbols for Nifty50 / BankNifty / FinNifty from a new `market_index_members` table.
  - `useOptionChainSnapshot(symbol, expiry)` reading `market_option_chain_snapshots`.
- Migration:
  - `market_index_members(index_key text, symbol text, exchange text default 'NSE', weight numeric, primary key(index_key, symbol))` + grants + RLS `USING (true)` (public reference data).
  - Seed Nifty 50 + Bank Nifty + Fin Nifty constituents (hard-coded list in migration).
  - Backfill `market_stocks` with the union of those constituents (name, sector, industry from a JSON literal in the migration).

## Phase 2 — Rewrite each route

Each route below gets: HUD header row (title + auto-refresh chip + manual Refresh), dense data panels, empty-state hint that names the exact action to populate it, keyboard shortcut hint. All numbers use `KineticNumber` + `PctCell`.

### Overview (`/market`) — Dashboard.tsx
Rows top→bottom:
1. **Indices strip** (6 indices already fetched) — sparkline from `market_daily_prices` last 30 days, price, %chg, day range.
2. **Global cues** — Dow, Nasdaq, S&P, USD/INR, Crude, Gold, BTC (already in `market_quotes` via `finance-market-sync`).
3. **Breadth** — advances/declines bar, new-highs/new-lows, above-50DMA %, above-200DMA %.
4. **Sector heatmap** — 11 GICS sectors coloured by 1D / 1W / 1M %chg (tabs).
5. **Top movers** — 3 tables side by side: Gainers / Losers / Most Active (F&O universe, top 10 each).
6. **Top breakouts & pre-breakouts** — existing tables, hooked to `market_stock_scores`.
7. **FII / DII flows** — from `fii_dii_activity` table, last 5 sessions bar chart.
8. **AI Take** — existing `market-morning-insight` call, streamed via Lovable AI Gateway.

### Portfolio group

- **Holdings** — table (symbol, qty, avg, LTP, P&L abs/%, day%chg, weight%, sector), summary bar (invested / current / unrealised / today's P&L), Kotak sync button, CSV import (Groww/Zerodha), inline delete.
- **Positions** — open F&O positions with LTP mark-to-market, expiry countdown, greeks placeholder, close-position modal.
- **Watchlist** — multi-watchlist tabs, add symbol picker, per-symbol chips (LTP, %chg, breakout score, RSI, distance-to-52w-high), drag-reorder.

### Research group

- **Screener** — left rail: preset screeners (Breakout, Oversold, 52w-high, High-volume, Momentum, Value); right: results table with score badges. "Save screener" writes to `market_saved_screeners`.
- **Analysis** (`/market/analysis/:symbol`) — split view:
  - Left 2/3: `CandleChart` (1D / 1H / 15m tabs) with EMA 20/50/200, VWAP, volume histogram, drawn support/resistance from `market_stock_scores.score_components`.
  - Right 1/3: score badge, key stats (mkt-cap, PE, PB, ROE, dividend from `market_fundamentals`), news feed from `market_news`, "Add to watchlist" / "Set alert" / "Open option chain" quick actions.
- **Options** (`/market/options/:symbol`) — expiry dropdown, spot + IV rank header, chain table (OI, chg-in-OI, IV, LTP for CE/PE at each strike, ATM highlighted), max-pain marker, PCR chip. Refresh calls `market-option-chain`.
- **Backtesting** — strategy dropdown (saved strategies from `market_saved_strategies`), date range, symbol/index selector, "Run" calls `market-backtest-run`; results panel: equity curve, drawdown, win rate, Sharpe, trade log.

### Alerts (`/market/alerts`)
Two tabs: **Active** (from `market_alerts` where `enabled=true`) and **Triggered** (last 30 days). "New alert" modal: symbol, condition (price >/< X, %chg >/<, RSI cross, breakout score cross), notify method (in-app + morning brief). Row actions: mute, edit, delete.

### Settings (`/market/settings`)
Sections:
1. **Broker connections** — Kotak Neo card with login/OTP flow (uses existing `market-kotak-login-*` fns), status (connected / expired / not connected), "Refresh token" button.
2. **Data preferences** — default exchange, IST vs local time, price update interval, sector taxonomy.
3. **Pipeline** — buttons: "Sync scrips", "Run EOD pipeline", "Sync holdings/positions", "Refresh quotes cache".
4. **Notifications** — morning brief on/off, alert channels.

## Phase 3 — Backfill / seeds

- Insert Nifty 50, Bank Nifty, Fin Nifty constituents (from index-member migration).
- Trigger `market-scrips-sync` and `market-pipeline-eod` once so `market_stocks`, `market_daily_prices`, `market_stock_scores` are populated.
- Prime `market_quotes` via `finance-market-sync`.

## Phase 4 — Verify

Playwright script hits `/market`, `/market/holdings`, `/market/screener`, `/market/analysis/RELIANCE`, `/market/options/NIFTY`, `/market/alerts`, `/market/settings`, screenshots each, asserts no `ErrorBoundary` fallback text, tails edge-function logs for 500s.

## Technical notes

- All new components live under `src/routes/market/` and `src/components/market/`; shared HUD primitives reused (`HudPanel`, `DataTable`, `Chip`, `KineticNumber`, `HudChart`).
- No changes to `src/routes/Market.tsx` tab shell — sub-tab config already matches the routes above.
- Edge functions to add: none new for MVP; may extend `market-indices` to include global cues instead of hitting `market_quotes` separately.
- Migration: 1 file — `market_index_members` table + grants + RLS + seed rows + backfill into `market_stocks`.
- No secret changes required (Kotak/AI keys already configured).

## Out of scope (explicit)

- No new cron schedule beyond what's already registered via `market_cron_call`.
- No mobile-specific layout pass.
- No paper-trading engine.

## Open assumption you can veto

I'll seed Nifty 50 + Bank Nifty + Fin Nifty (≈70 unique symbols) as the initial universe. If you want Nifty 500 or full F&O (~200 symbols), say so and I'll expand the seed list before running the migration.
