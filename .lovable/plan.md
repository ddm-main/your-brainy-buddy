# Market Section — Verified State & Execution Plan

## Live DB state (just verified)

| Item | State |
|---|---|
| Step 0 schema (all 9 items) | ✅ applied |
| Edge fns: `market-ai-recommend`, `market-alerts-eval`, `market-fii-dii-sync`, `market-fundamentals-sync`, `market-pipeline-eod`, `market-pipeline-aggregates`, `market-scrips-sync` | ✅ exist |
| `market_stocks` total | 2,699 |
| `is_nifty500` flagged | ⚠️ 211 / 500 |
| `market_stock_scores` rows | 267 (needs full-universe) |
| `market_fundamentals` | 0 (backfill never completed) |
| `fii_dii_activity` | 0 |
| `market_stock_ai` | 0 |
| `market_alert_events` | 0 |
| `market_breadth_daily` | 1 row |
| `push_subscriptions` | 0 |
| Routes `/market/breadth`, `/market/reports` | ❌ missing |
| `public/sw.js` + web push | ❌ missing (no `public/` dir) |
| Stock Analysis extra tabs (Financials/Peers/News/etc.) | ❌ missing |
| Zerodha / Dhan providers | ❌ missing |
| CommandPalette symbol search | ❌ missing |
| VAPID secrets | ❌ not configured |

**Bottom line:** Schema and cron scaffolding is done. What's missing is (a) data actually flowing, and (b) the frontend surfaces to consume it.

## Why one turn can't ship all of M1–M6 honestly

M3 (Analysis tabs + indicators), M4 (sw.js + VAPID + alerts history), M5 (breadth + reports + backup/restore + palette), M6 (two provider adapters + tests) is ~3–4 sessions of real work. Cramming it produces broken stubs. I'll execute in tight, verifiable batches instead — each batch leaves the app working.

## Execution plan (in order, one batch per turn)

### Batch 1 — Data (M1 finish) — no UI changes
- Fix `market-scrips-sync` to flag full Nifty 500 universe (currently 211/500).
- Trigger pipeline in order: `market-scrips-sync` → `market-pipeline-eod` (full universe scoring) → `market-fundamentals-sync` → `market-fii-dii-sync` → `market-pipeline-aggregates` → `market-ai-recommend`.
- Verify row counts land: fundamentals > 400, fii_dii > 0, ai_rows > 400, scores_today > 400, breadth appended.
- Outcome: Dashboard/Screener/Analysis you already have suddenly light up.

### Batch 2 — AI surfacing (M2 UI)
- Add Buy/Hold/Wait/Avoid + confidence chips to Dashboard top-breakouts, Screener rows, Analysis header (reads `market_stock_ai`).
- Dashboard regime chip (bull/neutral/bear) from `market_breadth_daily.market_score`.

### Batch 3 — Screener depth + indicators (M3 part A)
- Extend `_shared/market/indicators.ts`: VWAP, Supertrend(10,3), OBV, MFI(14), BB %B, candlestick + pattern flags → written by `market-pipeline-eod` into new score columns.
- Screener: register new columns in `FILTER_COLUMNS`; add fundamentals filters (P/E, PB, ROE, D/E, mcap).

### Batch 4 — Stock Analysis tabs (M3 part B)
- Analysis tabs: Financials / Quarterly / Shareholding / Peers / News / Corporate Actions / Dividends / Earnings (Yahoo `quoteSummary` + NSE RSS, 24h cache).
- Trade Planner block pre-filled from `market_stock_ai` (entry/SL/targets/holding period).

### Batch 5 — Alerts + Web Push (M4)
- Generate + store `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (asks user once).
- Create `public/` dir + `public/sw.js`; add opt-in flow in Settings that writes to `push_subscriptions`.
- Wire `market-alerts-eval` dispatch to web-push + email (existing sender).
- Alerts page: add "History" tab (last 100 `market_alert_events`).

### Batch 6 — Breadth + Reports + Settings + Palette (M5)
- New route `/market/breadth`: sector heatmap, rotation matrix, new-highs/lows series, %-above-EMAs history, market-score sparkline, FII/DII 30-day chart.
- New route `/market/reports`: report builder + CSV/Excel/PDF export (`xlsx` + `jspdf`).
- Settings polish: theme, refresh cadence, default timeframe & risk %, notification prefs, JSON Backup + Restore (watchlists/alerts/strategies).
- Extend `CommandPalette` with `market_stocks` symbol search → `/market/analysis/:symbol`.

### Batch 7 — Providers (M6)
- Add Zerodha Kite and Dhan behind existing `MarketProvider` interface (quotes/OHLCV/holdings/positions/orders read).
- Add `placeOrder` to interface; all providers throw `not-implemented`.
- Deno unit tests for each new parser.

## Rules held constant
- No changes to CRM / Finance / Deals code.
- Every new public table already has grants + RLS from Step 0.
- AI cost controlled via `score_hash` dedupe + batched Gemini flash.
- Yahoo `quoteSummary` via retry + host fail-over in `yahooClient.ts`; 24h cache.

## What I need from you
Approve this plan and I start **Batch 1** immediately. If you'd rather I merge two batches (e.g. 1+2 together, or 5+6), tell me and I'll adjust before starting.
