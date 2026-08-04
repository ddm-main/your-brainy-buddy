# Get DB and egress under 80% of the free-plan limits

Targets: database ≤ 400 MB (of 500 MB), egress ≤ 4 GB per billing cycle (of 5 GB).

## What the numbers actually say (verified just now)

- **Database: 404 MB / 500 MB = 81%.** Public tables are 377 MB of that. The
  top four are `market_daily_prices` 233 MB (482,863 rows, 2,992 symbols,
  history back to 2007), `market_indicators_cache` 47 MB (8,184 rows — all
  computed today, ~5.7 KB per row, fully recomputable),
  `market_stock_scores` 25 MB, `market_score_history` 14 MB.
- **Egress: 5.98 GB used, 0.98 GB over the 5 GB cap.** PostgREST is 93.8% of it.
- **One query is the whole problem.** `system_egress_daily` for today shows
  `srv:market_stocks` at **209 MB in a single day** across 2,250 requests
  (~93 KB each). That is the Kotak token map in
  `supabase/functions/_shared/market/provider.ts` (`getTokenMap`): it pages the
  entire tokened universe (3 pages × ~1,000 rows) with a 60-second in-isolate
  TTL. Edge isolates recycle constantly, so `market-quotes` (633 calls today)
  and friends re-read the full book almost every call. At today's rate that
  alone is ~6 GB/month — i.e. the entire cap.
- Everything else is small by comparison: screener rows 21 MB/day (30 loads
  × ~700 KB), `srv:market_api_settings` 3.4 MB (900 reads),
  `srv:market_daily_prices` 3.3 MB, `market-candles` 2.3 MB.
- **The in-app counter under-reports.** Measured egress since 23 Jul is only
  244 MB against a billed 5.98 GB, because the browser meter only counts open
  tabs and the server meter is wired into just `_shared/market/common.ts`
  (2 of 95 functions) and only started today. Any tuning has to be measured
  from the real meter, so the meter has to cover everything first.
- Storage is a rounding error and already used well: `market-archive` holds
  2,176 archived price objects at 6.3 MB; `statement-pdfs` is 20 MB.

## Fixes — egress

### 1. Stop shipping the token map on every call (the ~6 GB/month item)
- Add a narrow path to `getTokenMap`: when the caller knows its symbols
  (quotes, depth, candles, orders), resolve tokens with
  `select("symbol,exchange,token,kotak_segment,instrument_type").in("symbol", requested)`
  — a few KB instead of ~280 KB.
- Keep the full-book load only for the sync/master jobs that genuinely need it,
  and raise its TTL from 60 s to 30 min.
- Because isolates are cold, back the map with a single-row cache table
  (`market_indicators_cache`-style: one compact JSONB snapshot in
  `market_api_settings`-adjacent config or a new tiny `market_token_map_cache`
  row) refreshed by the weekly scrip sync, so even a full-map need is one
  ~40 KB compressed read a day rather than 750 reads of 280 KB.

### 2. Finish the metering so nothing hides again
- Install `installServerEgressMeter()` in the non-market functions too
  (finance-*, gmail-*, jarvis-*), via the shared bootstrap they already import.
- Add a per-route daily ceiling check in `apply_egress_governor()` so a route
  crossing (say) 50 MB/day gets flagged in the quota panel instead of silently
  burning the cycle.

### 3. Trim the remaining repeat readers
- `srv:market_feed_heartbeat` (730 reads/day) and `srv:market_holidays`
  (194 reads/day) are static-ish: cache in-isolate for the process lifetime.
- Screener load: drop `mcap_source`/`mcap_as_of` provenance expressions and the
  fundamentals columns from the default fetch, loading them only when a
  fundamentals filter or column is actually enabled — roughly halves the
  700 KB payload.
- `srv:market_api_settings` (900 reads): reuse the settings row within a request
  instead of re-selecting per provider call.

## Fixes — database

### 4. Shrink `market_daily_prices` (233 MB → ~130 MB)
Row counts by age: 241k rows inside 120 days, 157k in 120–260 days, 80.5k in
260–500 days, 4.3k older. The archive-to-storage path already works, so:
- Reduce the hot windows in `system_retention_config`: `prices_hot_tracked`
  500 → 300 days, `prices_hot_other` 260 → 150 days, `prices_inactive`
  180 → 120 days.
- Run the archive drain to push the evicted bars into the `market-archive`
  bucket (cheap: 2,176 objects currently total 6.3 MB) before deleting.
- Follow the delete with a `VACUUM FULL` (or repack) on the table — a plain
  DELETE leaves the pages allocated, so the reported 404 MB will not drop
  without it. This is the step that actually moves the number.

### 5. Stop `market_indicators_cache` costing 47 MB
It holds one day of fully recomputable series at ~5.7 KB a row.
- Store one row per symbol/timeframe with the indicator set as a single JSONB
  object instead of a row per indicator, and keep only the tail needed by the
  UI (not the full series).
- Cap it to tracked/in-universe symbols and prune to 1 day.
Expected: 47 MB → under 10 MB.

### 6. `market_stock_scores` / `market_score_history` (39 MB combined)
- `market_stock_scores` has 123 columns for 2,987 rows; move the large
  component blobs (`score_components`, `breakout_v4_components`,
  `data_provenance`) to a sibling table read only by the explain pages, so the
  hot table stays narrow for both disk and egress.
- `market_score_history` retention is 400 days; 250 days keeps the calibration
  windows intact and drops roughly a third of it.

### 7. Make the panel honest
`DatabaseStoragePanel` shows disk and egress; add the per-table top-10 and the
top egress routes from `system_egress_daily` so a regression is visible the day
it starts, not at the end of a cycle.

## Order of work
1. Token-map fix + meter coverage (stops the bleeding, makes the rest measurable).
2. Retention changes + archive drain + VACUUM FULL (gets disk under 400 MB).
3. Indicator cache reshape, score-blob split, score-history retention.
4. Screener/heartbeat/settings read trims.
5. Panel visibility + governor route ceilings.

## Technical notes
Files: `supabase/functions/_shared/market/provider.ts`,
`_shared/market/serverEgress.ts`, `_shared/market/common.ts` (and the finance/
gmail/jarvis function entrypoints), `supabase/functions/market-archive-prices`,
`src/lib/market/screenerRun.ts`, `src/components/config/DatabaseStoragePanel.tsx`.
Migrations: `system_retention_config` values, a token-map cache row, the score
blob split, `apply_egress_governor()` route ceilings, and the
`VACUUM FULL`/prune maintenance step. No user-visible behaviour change intended
— same data, far fewer bytes.
