## Goal

The Breakout Intelligence panel (A3) is already rebuilt around the score and the score-history feedback loop. All remaining work is data-side: make v4 produce scores, backfill history, and fit an honest calibration so the panel stops rendering empty states.

## Verified current state (live, 2026-07-29)

- `market_score_history` — **0 rows**.
- `market_stock_scores` — 2,907 rows, `breakout_score_v4` non-null on **0** of them.
- `market_scoring_calibration` — 12 rows, all `model_version` = `breakout_v2:2026-07-28` / `breakout_v2:2026-07-29`. No v4 rows.
- `market_score_distribution` — **0 rows**. `market_breakout_snapshots` — 0 rows.
- Universe: 2,852 active NSE symbols; latest `market_daily_prices` session 2026-07-29.
- `market_score_history` has no column for benchmark-relative returns and no liquidity flag; `prune_old_data` does not list it.
- `market_score_band_stats` view exists and matches what the UI reads.

## Required improvements

**1. Run the v4 aggregates pass**
Execute the aggregates function for session 2026-07-29 so `breakout_score_v4`, `band`, `rank_pct` and bucket contributions are written for the live universe, and one `market_score_history` row per scored symbol is snapshotted. Confirm the scored count is close to 2,852 and that unscoreable symbols (<120 bars) write a null score with a reason instead of a low number.

**2. Backfill `market_score_history` (~120 sessions)**
One-off routine replaying the v4 scorer over the last ~120 NSE sessions from `market_daily_prices`, writing one row per symbol per session. Run in chunks (symbol batches per session) to stay inside edge-function limits and to keep the write volume manageable — roughly 2,800 rows per session, ~340k rows total.

**3. Label neutral-context backfill rows**
Sector strength, RS-vs-NIFTY regime and news/AI context are not reconstructible historically. Mark those buckets in the row's `coverage` jsonb as `neutral` (not `present`), and exclude neutral-context rows from the calibration fit so r² is not flattered by synthetic inputs.

**4. Forward returns from `close_adjusted`**
Compute `fwd_ret_5d/10d/21d` from `COALESCE(close_adjusted, close)` on both legs, so a split inside the window doesn't register as a −50% failure. Only write a forward return when the full forward window exists; leave null otherwise so "maturing" stays distinguishable from "flat".

**5. Benchmark-relative returns**
Add `fwd_rel_5d/10d/21d` to `market_score_history` — the symbol's forward return minus NIFTY's over the identical window — and surface both absolute and relative hit rate in `market_score_band_stats`. Without this, a bull month makes every band look predictive.

**6. Liquidity filter in calibration**
Fit only on rows whose symbol was liquid/tradable on the snapshot date (turnover + price floor, matching the screener's `is_liquid_tradable` definition). Store the flag on the history row at write time rather than re-deriving it later.

**7. Purge legacy calibration rows**
Delete the 12 `breakout_v2:*` rows once v4 rows are fitted, so nothing reads v2 percentile stats as v4 weights.

**8. Per-bucket attribution**
Fit each of the 8 bucket contributions from the stored `buckets` jsonb against forward returns, writing one calibration row per bucket (`component`, `weight`, `r2`, `sample_n`) plus a row for the total score. This is what lets the panel say *which* section carries signal.

**9. Sample-size guard**
Bands and buckets with n < 200 matured rows report `sample_n` but no hit rate; the UI already renders "insufficient sample" for these.

**10. Populate `market_score_distribution`**
Write the daily v4 distribution (n, p50/p70/p90, max, strong/moderate/watch cut-offs) for every backfilled session and going forward, so percentile band cut-offs have a source.

**11. Retention**
Add `market_score_history` to `prune_old_data` with a ~400-day window and a `system_retention_config` key, and add `(trade_date, model)` plus `(symbol, exchange, model, trade_date DESC)` indexes for the pending-evaluation scan and the per-symbol panel read.

## Technical work

```text
migration
  ALTER market_score_history  + fwd_rel_5d/10d/21d, is_liquid_tradable, context_neutral
  CREATE INDEX  (symbol, exchange, model, trade_date DESC)
  CREATE INDEX  (trade_date, model) WHERE fwd_ret_21d IS NULL
  REPLACE VIEW  market_score_band_stats  + relative hit rate / avg
  REPLACE FUNC  prune_old_data           + market_score_history (400d)
  INSERT        system_retention_config  ('market_score_history', 400)

edge
  market-aggregates      → also write distribution rows + history snapshot
  market-score-backfill  → new one-off: replay ~120 sessions, chunked by session
  market-score-evaluate  → nightly: fill matured fwd_ret_* / fwd_rel_*, refit
                           calibration (per bucket + total), purge v2 rows

ui
  Settings → Sync gains a "Backfill score history" action with progress
```

Score maths is unchanged. The panel's honest empty states remain until the backfill and first evaluation pass complete; after that, forward returns mature progressively — the 21-day column stays sparse for the most recent three weeks by construction.
