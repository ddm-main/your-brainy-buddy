# Fix: Kotak positions never appear in the app

## What I found (verified against the live database)

1. **`market_positions` has no `product` column.** The positions sync writes `product` on every insert/update, so **every write fails** with a "column does not exist" error. The table currently holds **0 rows**, which matches the empty Positions/Portfolio cards.
2. **The failures are silent.** `market-sync-positions` only counts successes (`if (!error) inserted++`) and still returns `{ ok: true, inserted: 0 }`, so the UI shows a green "sync" with nothing synced.
3. **The frontend also breaks on the same column.** `usePositions()` selects `...,product`, which errors out against the real schema — so even if rows existed, the positions query would throw.
4. **Two unique indexes the code depends on don't exist**: the sync's race-recovery path references `idx_market_positions_broker_unique` and `idx_market_holdings_broker_unique`, but neither is present. Concurrent syncs can therefore duplicate rows instead of updating them.

## Fix

### Database migration
- Add `product text` (nullable, values MIS/CNC/NRML) to `public.market_positions`.
- Add the missing partial unique indexes:
  - `market_positions (user_id, exchange, symbol, side)` where `is_broker_synced` and `closed_at is null`
  - `market_holdings (user_id, exchange, symbol)` where `source = 'kotak_sync'`
- No new tables, so no new grants needed; existing RLS on both tables is unchanged.

### Edge function hardening (`market-sync-positions`, `market-sync-holdings`)
- Stop swallowing write errors: collect insert/update failures and return them in the response (`errors: [...]`) with a non-ok status when nothing could be written, so a broken schema or permission issue is visible instead of a silent "synced 0".
- Log the first failure with the symbol and Postgres error code.

### UI
- Surface the sync result: if a sync reports 0 written rows with errors, show a warning toast/inline message on Portfolio, Positions and Holdings instead of a silent success.
- No layout or styling changes.

## Verification
- Re-run the positions sync for the connected Kotak account and confirm the 4 positions land in `market_positions` (query the table directly).
- Confirm the Portfolio overview shows Open = 4 with exposure/unrealized populated, and the Positions page lists them with their product code.
