
# Market Deep-Check & Hardening — Execution Plan

Ground-truth review of the codebase against your brief. What's already landed vs. what's still open, and the exact order I'll ship it in (DB first per your rule).

## Already implemented (verified in code — will NOT re-do)

- Portfolio 4-tab (Overview / Holdings / Positions / Orders), `FundsCard`, `OrderTicket` with MARKET/LIMIT/SL/SL-M · MIS/CNC/NRML · trigger + margin preview — all wired.
- Backend: `market-funds`, `market-order-place` (Zod + margin guard), `market-order-modify`, `market-order-cancel`, `market-autotrade-fills` — deployed; migration `20260722095559` adds `exit_order_type`, `broker_sl_order_id`, fill columns.
- `market-autotrade-fills` **already** uses shared `kotakOrders()` via `withKotakSession` (WS3.1 done; no `kotakOrderBook` stub left).
- Provider split in `_shared/market/resolver.ts` (Kotak→Yahoo for price; FMP→Yahoo→NSE for fundamentals; alpha→computed for technicals).
- `preferNseExchange` / `kotakSegmentFor` / `pickNsePreferredListing` shared helpers **exist** on both server (`supabase/functions/_shared/market/exchangePreference.ts`) and client (`src/lib/market/exchangePreference.ts`).
- Cron: `market-alerts-eval` scheduled (migration `20260724102927`); `market-ai-recommend-nightly` scheduled (migration `20260722081142`). WS3.4 already done.
- Realtime tick coverage wired on Dashboard, Screener, Watchlist, Holdings, Positions, PortfolioOverview, IndexDetail, MarketStrip; `PriceSourceChip` present on portfolio surfaces.
- Daily orchestrator edge function `market-daily-sync` deployed (previous turn); cron insert was interrupted — re-issued below.

## Still open — what this plan ships

---

### Phase 0 — DB & scheduling (runs first, one migration + one insert)

**Migration `market_hardening_v1`:**

1. **Token drift reconcile.** Add `market_stocks.kotak_token bigint` mirror; backfill from `market_data.kotak_token` where present, else from existing `market_stocks.token`. Add a view column `market_pipeline_status.token_coverage_pct` (equities with a non-null Kotak token / equities total). Keep both physical columns for one release; `provider.ts` + relay will read a single accessor (Phase 2).
2. **Score-drift schema aid.** No column change needed — `market_data` already has `rsi`, `ltp`, `above_ema_200`, `breakout_score`, `prebreakout_score`, `score_components`. Just create index `idx_market_data_breakout_score_desc` for the AI-recommend query (Phase 4).
3. **Scoring v2 inputs.** Add nullable columns to `market_data`:
   - `obv_slope_20 numeric` (OBV linear-regression slope over 20 sessions)
   - `rolling_high_20 numeric`, `rolling_high_55 numeric`
   - `base_depth_pct numeric`, `base_length_days smallint`, `base_tightness numeric`
   - `dist_to_resistance_atr numeric`, `dist_from_pivot_atr numeric`
   - `rs_percentile_nifty smallint` (0–100)
   Populated by the updated pipeline aggregator (Phase 6). Backfill left null; scoring v2 degrades gracefully.
4. **Backtest calibration table.** `public.market_scoring_calibration(id, model_version, component, weight numeric, r2 numeric, sample_n int, computed_at)` — persists the fitted weights so scoring.ts loads them at cold start. Full RLS + grants.
5. **Provenance chip.** Add `market_data.price_source text` ('push_kotak' / 'live_kotak' / 'yahoo' / 'cache') set by `market-quotes` when it writes back; UI reads it as fallback when no fresh tick.

**Insert (data-only, uses vault-held cron secret — cannot go in migration):**

6. `cron.schedule('market-daily-sync-0900-ist', '30 3 * * *', ...)`; unschedule the redundant every-15-min `market-fundamentals-global-sync` and every-4-min `market-pipeline-eod` — the orchestrator now owns them.

---

### Phase 1 — Ground-truth spot-check of Kotak endpoints

Before any code hardens around them:
- Live probe (1-share non-filling LIMIT) to verify `market-order-modify` / `market-order-cancel` endpoint shapes in `kotakClient.ts` (currently commented "inferred").
- Verify `parseKotakLimits` field names match `/quick/user/limits` payload against the Kotak Neo app funds screen; record any correction into `kotakClient.ts` + a note in `System/Logs/2026-07-24.md`.

Deliverable: any string fixes to `kotakClient.ts`; nothing else changes if endpoints are correct.

---

### Phase 2 — Token coverage & relay reliability (WS1.1–1.2)

- `provider.ts` + relay read tokens through a new `_shared/market/tokenMap.ts` helper that prefers `market_data.kotak_token`, falls back to `market_stocks.kotak_token`, then legacy `market_stocks.token`. One canonical accessor everywhere.
- New `market-scrips-sync` pass writes into both columns; log `token_coverage_pct` per run.
- `src/routes/config/MarketConfig.tsx`: add "Kotak token coverage %" chip + "Relay: streaming / polling" indicator (already have `useRelayAlive`) with last-tick-age.
- `Apps/relay/kotak-ws-relay.mjs`: add exponential-backoff reconnect on WS close, heartbeat every 30 s, exit non-zero on fatal auth so pm2/nssm restarts it. Update `README.md` with `pm2 start ecosystem.config.js` snippet (Windows: `nssm install`).

---

### Phase 3 — Per-surface live-price audit (WS1.3, WS1.4)

Sweep every surface that renders a price/change%:

- Screener results **grid** columns (not just filter matching) → overlay `usePreferLiveTick` on displayed LTP/change%.
- `IndexDetail` header + constituent rows.
- `AutoTrade` open-position rows.
- `Orders` book pending-order LTP column.
- `Analysis` header already overlays; verify EMA overlays recomputed only from Kotak-consistent candles.

Every surface renders `<PriceSourceChip>` (or an inline `push·kotak / live·kotak / cache / delayed·yahoo` badge from the row's `price_source`).

**Indices Kotak-first:** `market-indices` currently Yahoo-first. Add Kotak index-token quotes for `NIFTY 50`, `NIFTY BANK`, `NIFTY MIDCAP 100`, `INDIA VIX` when the user has Kotak connected; fall back to Yahoo. Ship Kotak index tokens as a small seed insert.

---

### Phase 4 — Score-table drift fix (WS4.1)

- `market-ai-recommend/index.ts`: swap the read from `market_stock_scores(rsi14, close, above_ema200)` to `market_data(rsi, ltp, above_ema_200, breakout_score, score_components)`; adjust column refs.
- `market-stock-insight/index.ts`: same swap; keep the `score_components` blob as the tooltip source.
- Add a small compatibility fallback that reads legacy only if new value is null, so any partial-migration row still renders.

---

### Phase 5 — Chart forming candle (WS2)

- `CandleChart.tsx` / `TradingViewChart.tsx`: during market hours, mutate the last bar's `close/high/low` from `usePreferLiveTick` on every render so the forming candle tracks the header LTP; recompute the last EMA point from the mutated close.
- Add a `chart-source` chip ("candles · kotak" / "candles · yahoo") sourced from `market-candles` response metadata (new field).
- `market-candles`: when Kotak `/charts/v2/history` returns empty for a 1D/5m timeframe that Kotak *should* have, log a `chart_fallback_yahoo` row into `market_ingestion_runs` so we can see silent degradation.

---

### Phase 6 — Trading code hardening (WS3, WS5)

- `market-autotrade-eval`:
  - Entry sizing calls `getFunds()` and clamps against real `available_margin` (not just `max_capital_per_rule`).
  - If `rule.exit_order_type` ∈ ('SL','SL-M'), place resting broker stop right after entry fill, store `broker_sl_order_id`.
  - Circuit-breaker P&L reads `filled_price` (not `requested_price`).
- `AutoTrade.tsx`: surface broker positions from `market-positions` next to the ledger-derived list; mismatch → orange chip.
- Regenerate `src/integrations/supabase/types.ts` so `market_funds`, `market_autotrade_*` are typed → drop `as any` casts in `orderHooks.ts` / `autotradeHooks.ts`.

---

### Phase 7 — NSE-preferred resolution audit (WS1.4b)

- `SymbolSearchInput`, `getTokenMap`, `getActiveProvider`, `market-order-place` default routing, screener default `exchange` param → all call `preferNseExchange()` / `pickNsePreferredListing()` at the resolution boundary.
- `market_data` / `market_stocks` lookups keyed by symbol resolve to the NSE row when both exist.
- Holdings/Positions keep the broker-reported exchange, but their LTP reads through the NSE listing when the symbol has an NSE token.
- Regression test in `tests/exchangePreference.test.ts` locks the rule.

---

### Phase 8 — Breakout Score v2 (WS7)

Rewrite `_shared/market/scoring.ts`:

**Trigger & magnitude (25)** — close above `rolling_high_20/55` (real pivot); magnitude in ATR units; close-in-range (today's OHLC); freshness (1–3-session-old triggers score highest).

**Volume/participation (20)** — graded `relVolume`, `deliveryPct`, `obv_slope_20`.

**Trend & momentum (20)** — graded EMA stack + spacing (uses `atr14` to score spacing quality), `adx14` band (>25 rewarded), MACD-hist slope, RSI rising + >50 (drop the 55–70 cap; overbought is only penalized when combined with over-extension).

**Base quality (15)** — `base_tightness`, `base_length_days`, `bbSqueeze`/`atrContracting` re-derived from **raw** indicators (fixes the circular read from yesterday's `score_components` in `snapFromRow`).

**Relative strength & context (15)** — `rs_percentile_nifty` (IBD-style) + rising RS line + `sectorStrength`, then apply a market-breadth regime multiplier to the *breakout* score (parity with pre-breakout).

**Risk penalties (subtract, floor 0)** — over-extension in ATR units above pivot/EMA20; thin turnover; `dist_to_resistance_atr` too small (limited room); gap/erratic-base flag.

**Calibration.** New `market-backtest-calibrate` edge function: pulls 12 months of `market_daily_prices` + `market_data` history, computes 5/10/20-day forward returns per (symbol, date), fits a logistic regression on the graded component vector against "forward return in top-quartile", writes fitted weights to `market_scoring_calibration`. `scoring.ts` loads them at cold start (fallback: shipped defaults). Weekly cron on Sunday 06:00 IST.

**Contract stability.** Keep `breakoutScore(snap, ctx) → { score: 0..100, components: Record<string, number> }` shape. `ScoreBadge` / Screener tooltips keep working. Extend `tests/marketScoring.test.ts` with cases for trigger vs. proximity, extension penalty, ADX rewarded, calibration override.

---

### Phase 9 — Verification (post-approval, exits plan mode)

- `bun tsgo` clean; `bunx vitest run` green (new tests included).
- Dev server + relay during market hours: LTP/change% for ~10 liquid symbols + indices match Kotak Neo app / NSE within a tick; source chip shows `push·kotak` / `live·kotak`.
- Non-filling LIMIT round-trip: place → modify → cancel via the UI; `market_autotrade_orders` reflects status; `filled_price` written by fills worker on a real fill.
- Screener re-run: `breakout_score` differs materially from v1 on a true breakout vs. a proximity-only name; backtest report shows fitted weights beat defaults on forward-return separation.
- Append one-liner to `System/Logs/2026-07-24.md`.

---

## Technical details

- New migration touches only `market_stocks`, `market_data`, `market_pipeline_status`, `market_scoring_calibration`. All GRANTs + RLS included.
- `preferNseExchange()` helper stays the single rule authority; no scattered ternaries added.
- No secrets requested (Kotak / Lovable AI / cron secret already configured).
- Backtest calibration runs off-market-hours and writes only to `market_scoring_calibration`; scoring.ts hot-path stays synchronous with cached weights.
- Files touched (primary): `supabase/functions/_shared/market/{provider,tokenMap,scoring,exchangePreference}.ts`, `market-{ai-recommend,stock-insight,candles,indices,autotrade-eval,scrips-sync,backtest-calibrate}/index.ts`, `Apps/relay/kotak-ws-relay.mjs`, `src/components/market/{CandleChart,TradingViewChart,PriceSourceChip}.tsx`, `src/routes/market/{Screener,IndexDetail,AutoTrade,Orders}.tsx`, `src/routes/config/MarketConfig.tsx`, `src/integrations/supabase/types.ts` (regen), `tests/marketScoring.test.ts`, new `tests/exchangePreference.test.ts`.
