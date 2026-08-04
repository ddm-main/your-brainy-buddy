# Free-Plan Sustainability Plan — 2026-07-28

Goal: keep **every** Supabase free-tier meter under 80% forever.

| Section | Cap | 80% line | At start | Now |
|---|---|---|---|---|
| Database | 500 MB | 400 MB | 478 MB | 325 MB |
| File storage | 1 GB | 819 MB | 21 MB | ~30 MB |
| Egress | 5 GB/cycle | 4 GB | 1.99 GB | unchanged (cadence cut) |
| MAU | 50 000 | 40 000 | 4 | 4 |

## Root cause

`market_daily_prices` (1.1 M rows, 260 MB) plus derived caches were the whole
problem. Two feedback loops made it worse:

1. **Churn loop** — `market-history-backfill` ran every 15 min and re-fetched
   deep history for symbols the pruner had just deleted. Egress paid twice,
   database size never dropped.
2. **Index bloat** — btree indexes on append-only log tables
   (`market_provider_health`, `market_value_audit`, `market_ticker_trace`)
   cost more than the rows.

## What is now in place

**Storage tiering.** Postgres keeps only the hot window (≈500 trading days for
tracked symbols, ≈260 for the rest). Everything older is gzipped into the
`market-archive` bucket by `market-archive-prices` and read back on demand.
File storage is cheap and 97% free — that is the pressure valve.

**Governor.** `run_daily_maintenance()` runs 01:30 and 13:30 IST in three bands:
normal prune → aggressive (>380 MB, retention/3) → emergency (>430 MB: drop
indicator cache, shorten the hot window permanently, set `low_bandwidth`).

**Bandwidth brake.** `low_bandwidth` now short-circuits the non-essential jobs
(`market-history-backfill`, `market-news-sync`, `market-fmp-sync`) instead of
only being recorded.

**Cadence cuts** (egress): backfill 15 min → hourly, news 15 min → hourly,
shares-outstanding daily → 2×/day, archive drain every 10 min at 100 symbols
until the queue empties.

**Index diet.** Oversized btrees on log tables replaced with BRIN; redundant
composite indexes dropped.

## Fixed bugs

1. `market_archive_candidates` only ever returned symbols already archived once
   — coverage was stuck at 48/2547. Rewritten to return symbols that still hold
   cold rows. Coverage went 48 → 201 on the first run afterwards.
2. `market_history_backfill_candidates` read retention keys
   (`prices_tracked`/`prices_other`) that do not exist in
   `system_retention_config`, so it fell back to a 10-year target and fought
   the pruner. Now reads `prices_hot_*` and targets the hot window.
3. Backfill re-fetched symbols already archived — now skipped.
4. Quota panel counted archived symbols with a `head` count that ignored the
   universe size; replaced by `archive_coverage()` with a real drain progress bar.
5. Panel claimed "nightly at 01:30" and a 2-year hot window — both stale.

## 2026-07-28 (later) — churn tables made unlogged

`market_screener_snapshot`, `market_indicators_cache`, `market_quotes`,
`market_intraday_prices`, `market_provider_health`,
`market_provider_observations` and `market_ticker_trace` are now `UNLOGGED`.
All seven are rebuilt by cron or by the next sync, so losing them on a crash
costs nothing — and Postgres no longer writes a WAL copy of every rewrite.
That removes the main source of ongoing bloat between vacuums.

Archive drain raised from every 10 min to every 5 min until the backlog clears
(456 k rows still older than the hot window; coverage 201/2547).

## Remaining improvements (not yet done)

- **S2** Egress is not measurable from Postgres; the panel's egress bar stays
  empty unless the Supabase Management API is wired to a scheduled fn.
- **S3** Per-minute alert/autotrade jobs share one dispatcher opportunity.
- **S3** `VACUUM FULL market_daily_prices` would return ~60 MB of bloat to the
  OS but needs 2× the table size free; defer until the archive drain finishes.
- **S3** Client polls (`useAutoSync`, screener) still refetch full rows; column
  projections would cut egress further.

## 2026-07-28 (third pass) — the three real bugs

**1. The nightly governor had never run.** `run_daily_maintenance()` failed on
every single invocation with `missing FROM-clause entry for table
"run_daily_maintenance"` — a PL/pgSQL variable named `db_bytes` collided with
the column it was assigning to, so the whole function aborted before logging.
That is why `system_maintenance_log` was empty and `system_quota_state` still
read all zeros. Locals are now `v_`-prefixed; four runs have logged cleanly and
the quota row updates (db 294 MB, storage 25 MB).
`prune_old_data()` also dropped its temp table so the aggressive second pass
can no longer trip over the first pass's leftovers.

**2. History backfill failed 100% of the time.** PostgREST runs under
`authenticator`, which carries `statement_timeout = 8s`. Six workers pushing
500-row upserts into a 270 MB table exceeded it every time: `57014` for all 91
symbols, provider fetch paid for, nothing written. Fixes: concurrency 6→2,
upsert chunks 500→200, one 1.5 s retry on timeout, `service_role` timeout
raised to 20 s, and timeouts no longer increment `history_backfill_attempts`
(they were poisoning good symbols towards permanent give-up).
Verified run: **31/60 succeeded**, remaining failures are honest Yahoo 404s.

**3. Diagnostics cost more than they diagnosed.** Backfill wrote one
`market_provider_health` row per failed symbol — 91 rows an hour. Now one
aggregated row per run, and a **circuit breaker**: a run where ≥80% of symbols
fail tags the row `CIRCUIT_OPEN` and the next 6 hours of runs stand down
instead of burning egress. `{ force: true }` overrides.

### Also done
- Dropped the surrogate `id` PK on `market_daily_prices` (32 MB of index, 8 B
  per row, referenced by no code); the natural key is now the primary key.
- Archive deletes are chunked year by year with a retry — a single decade-wide
  DELETE could time out *after* the object was uploaded, stranding the rows.
- `archive_coverage()` reported `pending` from a candidate list capped at 200,
  so the panel showed a fixed number forever. It now counts the true backlog
  (997 symbols) and returns the last maintenance run.
- Removed dead retention keys `prices_tracked` / `prices_other`.
- Merged three `*/2` jobs (autotrade-eval, autotrade-fills, alerts-eval) into
  one `market-intraday-dispatch` — ~480 fewer invocations a day.

DB **280 MB / 500** (56%), storage 25 MB / 1 GB (2.5%), egress ~2.1 / 5 GB.

## Why file storage is "only" 22 MB
Nothing is broken. 401 symbols of gzipped OHLCV weigh 3.2 MB; the whole 2547
symbol universe projects to roughly **20-30 MB**. Daily bars compress ~15:1.
The 1 GB bucket will never be the constraint — it is doing its job, which is
keeping ~200 MB of cold rows *out of Postgres*.

## Egress pass 3 (2026-08-04) — 4 GB self-imposed budget
The 5 GB cycle cap is the hard line; we now run against a **4 GB budget**, and
past 80% of it `apply_egress_governor()` sets `low_bandwidth`, which already
short-circuits the non-essential syncs. Egress is not readable from Postgres —
`supabase-usage-sync` (cron `5 2,14 * * *`) pulls it from the Supabase
Management API with `SB_MANAGEMENT_TOKEN` and writes `egress_bytes`, the cycle
window and the per-type split into `system_quota_state`; the Storage & Quota
panel and the navbar chip read it from `quota_report()`.

### Cadence after this pass
| Job | Was | Now |
|---|---|---|
| market-score-backfill-drain | `*/15 3-14 * * 1-5` | `10 19,22 * * 1-5` |
| market-screener-snapshot-refresh | `*/30` market hours | `0 4-11 * * 1-5` |
| market-selftest-fast | `*/30 3-10` | `15 3-10 * * 1-5` |
| market-selftest-hourly | `5 */6 * * *` | unscheduled |
| supabase-usage-sync | — | `5 2,14 * * *` |

### Byte cuts
- `market-pipeline-aggregates`: explicit projection + server-side `trade_date`
  filter instead of paging all 123 columns of every session (~25 MB → ~2 MB/run).
- `statements` list reads drop `extracted_text` (full PDF text); only
  `statements.get` still takes it.
- Explicit column lists for `market_pipeline_status`, `market_api_settings`,
  `market_saved_screeners`.
- Dev-only `src/lib/egressMeter.ts`: logs any response over 256 KB and
  `__egress()` prints per-read totals, so a regression shows up while building.
