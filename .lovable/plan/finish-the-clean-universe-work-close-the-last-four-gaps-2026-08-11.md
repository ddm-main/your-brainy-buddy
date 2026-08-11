# Finish the clean-universe work: close the last four gaps

Most of the original plan is already live. Checked against the database just now.

## Already done (verified)

- Blocklist exists and is populated: `market_excluded_symbols` holds 1,858 names — 677 `cap<1000cr`, 507 `inactive`, 506 `non_equity`, 168 `no_market_cap`.
- `market_stocks` is down to 1,447 rows: 1,442 in universe, 1 penny-flagged, 5 inactive (all index rows, not stocks).
- The blocklist is enforced in the database: `market_penny_sweep()`, `enforce_penny_exclusion` and `block_penny_rows` all reference it, so a blocklisted name cannot be re-created or write derived rows.
- Non-equity classification exists as `market_is_non_equity()`; ETFs, SME (SM/ST) and BE/BZ series are out.
- Monthly crons on the 1st (listing refresh 02:00, penny sweep 02:30) are in place.
- `market_nse_master` no longer contains anything outside the universe (0 such rows), and only 4 orphan symbols remain in `market_daily_prices`.

## Remaining gaps

### 1. Fifteen in-universe rows still have no market cap

14 are real EQ companies (SHRIKRISH, LAHOTIOV, MADHAVIPL, MERCANTILE, RRIL, GRAVISSHO, QUINT, COMFINTE, FEDDERSHOL, AARNAV, ABANSENT, BIRLAPREC, 3PLAND, IWP); the 15th is the Sensex index row `^BSESN`, wrongly marked `in_universe = true`.

Fix: derive cap from shares outstanding x last close where possible, then blocklist as `no_market_cap` whatever still has none. Target after the run: zero.

### 2. Index rows must never be in the universe

`^BSESN` is in-universe today; the other index rows escape only because they are inactive. Make `instrument_type = 'INDEX'` a hard exclusion in the ingest guard and in the sweep, so index rows can exist for charting but never count as tradable universe members.

### 3. Symbol-reading jobs still filter on the old flag

Only `market-fundamentals-sync` filters `in_universe = true`. `market-pipeline-eod`, `market-shares-outstanding-sync` and `market-scrips-sync` still use `penny_excluded is not true`, and the universe RPCs — `market_live_sweep_universe`, `market_live_watch_universe`, `market_history_backfill_candidates`, `market_score_backfill_candidates`, `claim_market_fundamentals_sync` — filter on neither `in_universe` nor the blocklist.

Fix: switch all of them to `in_universe = true`. Same result today, but it becomes the single gate, and every run fetches fewer symbols.

### 4. Search coverage and drift visibility

- 91 in-universe names are missing from `market_nse_master`, so search and autocomplete cannot offer them. Reconcile master to the universe.
- Delete the 4 orphan price symbols.
- Have the monthly sweep write a one-line summary (added, removed, blocklisted, universe size, null-cap count) to the maintenance log, and add a null-cap check to the daily data-validation job so this cannot drift silently again.

## Technical notes

- One migration: universe RPCs and `claim_market_fundamentals_sync` re-filtered on `in_universe`; `market_penny_sweep()` gains the shares-outstanding x close cap fallback, the `no_market_cap` blocklist step, the INDEX exclusion and the maintenance-log summary; ingest guard rejects INDEX rows from the universe.
- One data operation: stamp `in_universe = false` on index rows, blocklist any remaining capless name, delete the 4 orphan price symbols, seed the 91 missing `market_nse_master` rows, then refresh the screener snapshot and score distribution.
- Edge-function edits: filter swap in `market-pipeline-eod`, `market-shares-outstanding-sync`, `market-scrips-sync`; null-cap assertion added to `market-data-validation`.
- Verification: zero in-universe rows with null cap, zero INDEX rows in universe, universe count equal to `market_nse_master` count, zero orphan price symbols, and the sweep's log entry present after a manual invocation.