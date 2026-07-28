## Confirmed current state

- The screener is stale because `market_screener_snapshot` and `market_stock_scores` are still on `2026-07-24`.
- `market_daily_prices` already has `2026-07-28` prices for the active NSE universe, so raw price data exists.
- The daily sync is failing on two concrete blockers:
  - `market-nse-bhavcopy-sync` tries to upsert `exchange`, but `market_eod_nse` does not currently have that column.
  - `refresh_market_screener_snapshot()` runs `DELETE FROM market_screener_snapshot` without a filter, and Supabase rejects it with `DELETE requires a WHERE clause`.
- `market-pipeline-eod` marks 2,501 NSE symbols as synced today, but `market_stock_scores` has 0 rows for `2026-07-28`; this means the cursor advanced while the score table did not catch up.

## Plan

1. **Repair the database pipeline blockers**
   - Add `exchange` to `market_eod_nse` with default `NSE`.
   - Rebuild the `market_eod_nse` primary key as `(symbol, exchange, trade_date)` so the edge function’s upsert conflict target is valid.
   - Replace `refresh_market_screener_snapshot()` with a safe filtered delete and insert routine.

2. **Add a database-side catch-up rescore**
   - Create `market_rescore_latest_from_prices(trade_date, limit)`.
   - It will rebuild the latest `market_stock_scores` rows directly from `market_daily_prices` for the target date, using stored candles instead of fetching provider candles again.
   - This gives the screener a reliable recovery path when Kotak/Yahoo candle fetches fail but daily prices already landed.

3. **Patch the EOD edge function**
   - Before fetching external candles, detect symbols whose latest stored `market_daily_prices` date is newer than their `market_stock_scores` date.
   - Prefer local-price rescore for those symbols rather than burning egress on another provider fetch.
   - Only advance `market_stocks.last_price_sync_at` after score write/rescore succeeds.
   - Lower EOD concurrency slightly if needed to reduce Supabase free-plan pressure.

4. **Patch the daily orchestrator**
   - After EOD and before aggregates/snapshot, call the new database catch-up rescore.
   - Keep the chain resilient: if NSE bhavcopy is delayed, it should still rescore from already-present `market_daily_prices`.

5. **Run the recovery once**
   - Trigger the new rescore for `2026-07-28`.
   - Run aggregates.
   - Refresh the screener snapshot.

6. **Verify the result**
   - Confirm `market_stock_scores`, `market_screener_snapshot`, and the UI-visible `market_screener_rows` all report max `trade_date = 2026-07-28`.
   - Confirm the red “Data is 4 days behind” banner disappears.
   - Check recent ingestion logs for failures and list remaining improvements.

## Required improvements after the fix

- Replace provider-first scoring with a price-table-first scoring path permanently.
- Add an ingestion invariant: do not mark a symbol “synced today” unless its score row is also updated.
- Add a daily health check that alerts when `market_daily_prices` is newer than `market_stock_scores` or `market_screener_snapshot`.
- Keep `market_provider_health` compact; current failures are useful, but success logs should stay sampled.
- Consider making NSE bhavcopy the primary EOD source for close/volume, with Yahoo/Kotak only for missing symbols and deep history.