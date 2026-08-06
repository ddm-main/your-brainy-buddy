# DB cleanup — reclaim the space the penny purge freed

Verified against the live database just now. The penny work and the 2-year ceiling are complete; what remains is that the deleted space was never returned to disk.

## Verified current state

- 1,209 symbols flagged `penny_excluded`, tradable universe 1,620. Zero penny rows in daily prices, indicators, scores, score history, screener snapshot, NSE master. Zero penny archives (index 1,504 objects, none penny).
- 2-year ceiling holding: `market_daily_prices` starts 2024-08-05, 0 rows and 0 archive objects beyond the cutoff.
- Database is **406 MB of the 500 MB free-plan cap** — despite the purge, because Postgres does not shrink files after a delete:

| Table | On disk | Live rows | Reality |
|---|---|---|---|
| market_daily_prices | 233 MB (186 MB heap + 47 MB index) | 203,597 | ~640 B/row — should be ~30 MB |
| market_indicators_cache | 48 MB (45 MB of it TOAST) | 4,668 | bloat from repeated JSON rewrites |
| market_stock_scores | 26 MB | 1,820 | wide table plus dead space |
| market_score_history | 14 MB | 5,812 | dead space |

Autovacuum has run on all of them (0–650 dead tuples), so this is pure file bloat: only `VACUUM FULL` / `REINDEX` returns it.

## The fix

### 1. One-off compaction of the four bloated tables

`VACUUM FULL` cannot run inside a transaction, so it is issued through `pg_cron` (each cron statement runs standalone). Schedule a one-shot job that runs, in order:

```
VACUUM (FULL, ANALYZE) public.market_daily_prices;
VACUUM (FULL, ANALYZE) public.market_indicators_cache;
VACUUM (FULL, ANALYZE) public.market_stock_scores;
VACUUM (FULL, ANALYZE) public.market_score_history;
```

then unschedules itself. Each table takes a brief exclusive lock (seconds at this size); the job runs off-market-hours so no ingest job is blocked. Expected result: roughly **400 MB → 130–160 MB**.

### 2. Keep it from coming back

Add a monthly `pg_cron` job (`jarvis-monthly-vacuum`, right after the existing 1st-of-month ceiling prune at 02:30 and archive prune at 02:45 — so 03:00) that repeats the same compaction. The monthly ceiling prune deletes a month of bars every run, which is exactly what re-bloats these tables, so the compaction belongs immediately after it.

### 3. Verify

After the run: re-check `pg_total_relation_size` per table and `pg_database_size`, and confirm row counts are unchanged (203,597 daily bars, 1,620 universe, 0 penny rows anywhere).

## Technical notes

- No application code, no UI, no edge-function changes. Two `cron.schedule` calls plus verification queries.
- `VACUUM FULL` rewrites the table and all its indexes, so no separate `REINDEX` is needed.
- Nothing is deleted in this step — row counts before and after are identical; only free space is returned.
