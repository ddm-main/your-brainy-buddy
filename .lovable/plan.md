# Market App — Deep Check, Live-Price Correctness & Hardening

Executing the reviewed plan in order, starting with DB/backend issues, then backend logic, then frontend, then scoring v2, then verification. Each workstream lands as a self-contained set of edits so we can validate incrementally.

## Phase 1 — Database & backend integrity (first)

1. **Token-source reconciliation (migration)**
   - Add a migration that backfills `market_stocks.token` from `market_data.kotak_token` (and vice versa) so provider.ts and the relay subscribe to the same tokens.
   - Add `market_pipeline_status` fields (or view) exposing `token_coverage_pct` for the tradable universe.
   - If needed, add columns to `market_data` for new scoring v2 inputs (OBV, base_tightness) — only if computing them server-side.

2. **Missing crons**
   - Verify `cron.job` for `market-alerts-eval` and `market-ai-recommend`. If absent, add `cron.schedule` entries (via `supabase--insert`, per the scheduled-jobs rule — not a migration, since secrets/URLs are project-specific).

3. **Score-table drift**
   - Point `market-ai-recommend/index.ts` and `market-stock-insight/index.ts` at unified `market_data` columns (`rsi`, `ltp`, `above_ema_200`, …) instead of legacy `market_stock_scores`. Verify each column name against `market_data` schema before editing.

4. **Regenerated Supabase types**
   - After migrations run, confirm `market_funds` and `market_autotrade_*` appear in `src/integrations/supabase/types.ts`; drop `as any` casts in `orderHooks.ts` / `autotradeHooks.ts`.

## Phase 2 — Backend: live-price & trading hardening

5. **Kotak token coverage & NSE-preference helper**
   - Add `preferNseExchange(symbol)` in `supabase/functions/_shared/market/` + a client mirror in `src/lib/market/`.
   - Update `getTokenMap` / `getActiveProvider` / `kotakProvider.getQuotes` so any symbol with both NSE + BSE tokens resolves to NSE; BSE only when NSE token absent.
   - Ensure whole-batch Kotak failure falls back per-symbol, not entire batch, before hitting Yahoo.

6. **Kotak endpoint & code hygiene**
   - `market-autotrade-fills/index.ts`: replace ad-hoc `fetchOrderBook` with the exported `kotakOrders()` from `kotakClient.ts`; remove dead `kotakOrderBook()` stub; reconcile `/quick/user/orders` vs `/orders/1.0/orders` to the verified endpoint.
   - Confirm `market-order-modify` / `market-order-cancel` endpoints in `kotakClient.ts` (remove "inferred" flags after live probe in Phase 5).

7. **market-candles intraday Kotak-first**
   - Ensure `provider.getOHLCV` uses Kotak `/charts/v2/history` for all requested TFs when a token exists; fall back to Yahoo per-symbol only. Attach a `source` field to the candle response for a chart-source chip.

8. **market-indices Kotak-first**
   - Add Kotak index quote path (index tokens differ from equities). Fall back to Yahoo when absent.

9. **market-autotrade-eval hardening**
   - Cross-check funds-aware sizing uses `getFunds` available margin.
   - Verify `rule.exit_order_type` places a resting SL/SL-M and records `broker_sl_order_id`.
   - Circuit-breaker/P&L reads `filled_price` (not `requested_price`).
   - Kill-switch remains default-off.

## Phase 3 — Frontend: uniform live-price & NSE preference

10. **Uniform live-price consumption** — use `usePreferLiveTick` on every price/change surface:
    - `Dashboard.tsx`, `WatchlistPanel.tsx`, `Holdings.tsx`, `Positions.tsx`, `PortfolioOverview.tsx`, `Orders.tsx`, `Screener.tsx` (results grid columns), `Analysis.tsx` header, `IndexDetail.tsx`, `AutoTrade.tsx`.
    - Extend `useRealtimeTicks` subscription coverage to every visible symbol set on these surfaces.
    - Show honest source chip (`push·kotak` / `live·kotak` / `delayed·yahoo` / `cache`).

11. **Forming-candle live merge**
    - In `CandleChart.tsx` / `TradingViewChart.tsx`, merge `usePreferLiveTick` into the last daily bar during market hours so the forming candle tracks live price. Add a chart-source chip using the new candle `source` field.

12. **NSE-preferred client resolution**
    - `SymbolSearchInput` returns NSE row when both listings exist.
    - Screener default exchange = "NSE"; results grid + saved screeners operate on NSE listing.
    - `OrderTicket` defaults & prefers `nse_cm`; BSE only for BSE-only or explicit choice.
    - Holdings/positions retain broker exchange but valuation quote uses NSE listing when NSE-listed.

13. **Relay health surface**
    - Add token-coverage % + relay-status tile to `src/routes/config/MarketConfig.tsx`.
    - Supervise `Apps/relay/kotak-ws-relay.mjs` (pm2 config + README startup docs). Docs-only change if pm2 install is out of scope.

## Phase 4 — Screener & scoring v2

14. **Screener display freshness**
    - Results grid price/change% columns show live overlay during market hours; coverage-% chips reflect `market_data` reality.

15. **Breakout scoring v2** (`supabase/functions/_shared/market/scoring.ts`)
    - Replace mostly-binary components with graded 0–1 × weight, still summing to 100:
      - Breakout trigger & magnitude (25): close above rolling 20–55d high, magnitude in ATR units, close-in-range, freshness.
      - Volume/participation (20): graded relVolume, deliveryPct, OBV/up-vol trend.
      - Trend/momentum quality (20): EMA stack + spacing, ADX14, MACD hist slope, RSI rising & >50 (drop hard 55–70 band).
      - Base/consolidation (15): tightness (atrPct, bbWidth), depth/duration, fixed bbSqueeze/atrContracting from raw indicators (not yesterday's score_components).
      - RS & context (15): RS-vs-NIFTY percentile + rising RS, sectorStrength; regime multiplier on total.
      - Risk penalties (subtract, floor 0): over-extension in ATR units, thin liquidity, gap risk, limited room to next resistance.
    - Fix `snapFromRow` circular derivations in `market-pipeline-aggregates/index.ts`; feed real ema/volume series.
    - `preBreakoutScore` on same graded footing.
    - Keep `score_components` shape stable so `ScoreBadge` tooltips still work.
    - Extend `tests/marketScoring.test.ts` with graded-component tests, real-breakout-vs-near-52wh spot check.
    - Calibration: use `market-backtest-run` to compute 5/10/20d forward returns; tune weights (simple fit acceptable) and record the report.

## Phase 5 — Ground-truth validation

16. `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test` clean.
17. During market hours: run dev + relay; drive with Playwright, compare LTP/change%/holdings/positions/balance for ~10 liquid symbols + indices against Kotak Neo app + NSE. Screenshot each surface, log discrepancies, trace to WS1/2/3.
18. Live probe: 1-share non-filling LIMIT → verify Orders list → Modify → Cancel → then tiny MARKET/SL probe; confirms `market-order-modify/-cancel` endpoints.
19. Trigger `market-alerts-eval` once; confirm a `market_alert_events` row.
20. Append one-line entry to `System/Logs/<today>.md` noting the hardening pass + any Kotak field-mapping corrections.

## Technical notes

- No new tables required unless calibration or OBV inputs demand persisted columns; will decide after reading `market_data` schema in Phase 1.
- `preferNseExchange` lives in one shared module, mirrored to client, to keep the rule DRY.
- Scoring v2 keeps `{score, components}` return shape — UI unaffected.
- All Kotak endpoint changes gated on a live probe before wiring to buttons (safety directive).
- Relay supervision is ops/docs; no runtime code required beyond a pm2 ecosystem file if approved.

## Order of execution

Phase 1 (DB + score-table drift) → Phase 2 (backend live-price + trading) → Phase 3 (frontend uniform live) → Phase 4 (screener freshness + scoring v2 + tests) → Phase 5 (ground-truth on approval, market hours).
