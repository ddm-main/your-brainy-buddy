# Penny purge + 2-year ceiling — status check

Verified against the live database and the edge-function sources just now. Almost the entire plan is already shipped. One concrete item is left.

## Already done (verified)

- 1,209 symbols flagged `penny_excluded`; tradable universe is 1,620.
- Hard DB gate live (`block_penny_rows` triggers) and insert guard `enforce_penny_exclusion` on `market_stocks`.
- Zero penny rows remain in daily prices, stock scores, score history, screener snapshot, or NSE master (all checked, all 0).
- Weekly sweep `market-penny-sweep-weekly` active (`15 4 * * 6`) with its post-flag purge step.
- Job filters: `market-fundamentals-sync`, `market-live-sweep`, `market-shares-outstanding-sync`, `market-scrips-sync` and `market-archive-prices` all filter `penny_excluded`. The two candidate DB functions (`market_history_backfill_candidates`, `market_score_backfill_candidates`) and `market_archive_candidates` filter penny inside the function body, so history-backfill and score-backfill are already covered. `market-daily-sync` and `market-score-evaluate` read from `market_eod_nse` / score tables, which are themselves penny-free by trigger, so no extra filter is needed there. `market-news-sync` only pulls names for watchlist/holdings symbols.
- 2-year ceiling is shipped: retention key `max_history_days = 730`, function `prune_beyond_history_ceiling()` (including archive trimming), and two monthly crons — `jarvis-monthly-history-ceiling` (`30 2 1 * *`) and `market-archive-prune-monthly` (`45 2 1 * *`).
- The ceiling has already run: `market_daily_prices` now starts at 2024-08-05, **0 rows** older than 2 years, **0** archive entries older than the cutoff.

## Remaining item — penny archives still in cold storage

`market_archive_index` holds 2,590 objects, of which **1,086 belong to penny-flagged symbols** (≈91,000 archived bars). The prune path exists (`market-archive-prices` with `mode: "prune"`) and is scheduled, but its first run is 1 September — so the penny objects are still sitting in the `market-archive` bucket and their index rows still make penny names look like they have deep history.

Fix: invoke `market-archive-prices` once now with `mode: "prune"`, which deletes those bucket objects and their `market_archive_index` rows, then re-verify the penny archive count is 0.

## Technical notes

- No code changes, no migration, no UI work — this is a single one-off invocation of an already-deployed function plus verification queries.
- The monthly cron then keeps both penny archives and beyond-ceiling archives cleaned automatically.
