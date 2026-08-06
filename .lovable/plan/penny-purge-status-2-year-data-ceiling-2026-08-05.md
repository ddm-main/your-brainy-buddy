# Penny purge status + 2-year data ceiling

Verified against the live database just now. Most of the penny plan is already shipped; two things remain, plus the new retention requirement.

## Already done (verified)

- 1,209 symbols flagged `penny_excluded`; universe is 1,620.
- The hard DB gate is live: `block_penny_rows` triggers exist on all 18 intended tables (daily prices, intraday, live prices + stage, eod_nse, quotes, indicators cache, stock scores, score history, fundamentals, fundamentals_global, shares outstanding, news, stock_ai, breakout tracker + snapshots, screener snapshot, nse_master).
- The insert guard on `market_stocks` (`enforce_penny_exclusion`) stamps a new row penny on insert when `market_cap < 1000`, and re-asserts `in_universe = false` for any flagged row.
- The one-time purge is complete: **zero** penny rows remain in every one of those tables (all 14 checked came back 0).
- Weekly sweep `market-penny-sweep-weekly` is scheduled and active (`15 4 * * 6`) and its code already includes the post-flag purge step.

## Remaining item 1 — stop the jobs fetching penny symbols

Only `market-scrips-sync`, `market-live-sweep`, `market-shares-outstanding-sync` and the sweep itself filter on `penny_excluded`. These still pull all 2,829 symbols and throw ~1,209 away (the triggers drop the writes, so it's pure wasted egress/runtime):

- `market-daily-sync`
- `market-score-evaluate`
- `market-score-backfill`
- `market-history-backfill`
- `market-fundamentals-sync`
- `market-news-sync`

Each gets `.not("penny_excluded", "is", true)` on its universe select. Where the symbol list comes from a DB function (`market_history_backfill_candidates`, `market_score_backfill_candidates`), the filter goes into the function body instead so the candidate list itself excludes penny names.

## Remaining item 2 — leftover penny archives in Storage

The purge cleared tables but not the price archive: **1,086 archive objects** in `market_archive_index` still belong to penny symbols. Those get deleted from the storage bucket and their index rows removed, and the archive job gets the same penny filter so it stops writing new ones.

## New: hard 2-year data ceiling, cleaned monthly

Today retention is per-table day windows (300/150/120 days for prices, 250 for score history, etc.) run twice daily by `jarvis-daily-maintenance`. There is no absolute ceiling, and history predating it survives in gaps: `market_daily_prices` goes back to **2007-09-17**, with **4,136 rows older than 2 years**; 688 archive entries also start before the cutoff.

Add a single ceiling that nothing escapes:

1. New retention key `max_history_years = 2`.
2. New function `prune_beyond_history_ceiling()` — batched deletes of anything dated older than `current_date - 2 years` across every symbol-dated table: daily prices, eod_nse, intraday, indicators cache, score history, breakout snapshots, news, live prices, screener snapshot, provider observations, value audit, ingestion runs.
3. Archive trimming: archive index rows whose window ends before the cutoff are deleted along with their storage objects; partially-old archives are left (their recent bars are still valid) and re-written by the archive job.
4. New monthly cron `jarvis-monthly-retention` (1st of month, 02:30 UTC) calling it, logged to `system_maintenance_log` so the result is visible in Config → Database & Storage.

The ceiling runs **after** the existing shorter windows, so it never fights them — it only catches what they miss.

## Technical notes

- The ceiling deletes in 50k-row batches via the existing `prune_batched` helper — no long lock on `market_daily_prices`.
- Storage deletes for penny/old archives run from an edge function (`market-archive-prices` gains a `mode: "prune"` path), since SQL can't remove bucket objects.
- No UI work. Screener/breakout/scoring already read the narrowed universe.
- Files touched: six edge-function universe filters, `market-archive-prices` prune path, one migration (ceiling function + retention key + candidate-function filters), one cron insert, one batched purge of penny archives.
