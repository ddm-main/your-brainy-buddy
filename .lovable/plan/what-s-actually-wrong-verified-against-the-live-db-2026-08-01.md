## What's actually wrong (verified against the live DB)

Prices are current — `market_daily_prices` has 2,718 rows for **2026-07-31** (Fri; Aug 1 is Saturday, so Jul 31 is the correct last session). The **scores** table is what's stale: `market_stock_scores` has only 1,203 rows on Jul 31 and **1,559 rows frozen on Jul 30** — BAJFINANCE, RELIANCE and TCS are all in the frozen set (price date Jul 31, score date Jul 30). That's exactly the "EOD Jul 30 · 2d old" chip you selected.

Three confirmed root causes, from last night's orchestrator run (`market_ingestion_runs`, status `partial`):

**1. A migration in the repo was never applied to the database.**
`supabase/migrations/20260801090000_v4_snapshot_roundtrip_columns.sql` adds 10 columns (`atr_contracting`, `support_fallback`, `resistance_fallback`, `resistance_above`, `breakout_state`, `breakout_level_cleared`, `rolling_high_20_touches`, `rolling_high_20_touch_quality`, `macd_hist_rising`, `weekly_bars`). `information_schema` shows none of them exist, and `schema_migrations` jumps from `20260801053303` to `20260801162312` — that version was skipped. `market-pipeline-eod` writes those fields, so **every single per-symbol upsert fails**: last run logged `processed: 38, succeeded: 0, failed: 38`, each with `Could not find the 'atr_contracting' column ... PGRST204`. The technicals pass has been a total no-op since that code shipped.

**2. The bulk fallback rescore times out.**
The orchestrator calls `market_rescore_latest_from_prices(_limit => 3000)`. It ran 72s and died with `canceling statement due to statement timeout`. So the cheap "rebuild scores from stored prices" recovery path — the safety net for cause #1 — also fails. Same call is made inside `market-pipeline-eod`, where it fails silently too.

**3. The EOD chunk picks symbols by the wrong cursor.**
`market-pipeline-eod` selects candidates where `market_stocks.last_price_sync_at` is older than today. The NSE bhavcopy step stamps that cursor, so symbols whose *prices* are fresh but whose *scores* are stale are never picked — the chunk drained after 38 candidates while 1,559 symbols sat un-rescored. `market-pipeline-aggregates` then reported `stale_skipped: 1566` because it only aggregates rows on the latest trade date.

Net effect: the only symbols that advanced to Jul 31 were the ~1,200 the aggregates pass could rescore in place; everything else froze.

## Fix plan

### 1. Apply the missing schema (unblocks everything)
Re-issue the 10 `ADD COLUMN IF NOT EXISTS` columns as a fresh migration so the applied history matches the repo. No grants needed (existing table).

### 2. Make the rescore RPC finish
- Add `SET LOCAL statement_timeout = '240s'` inside `market_rescore_latest_from_prices` (it is `SECURITY DEFINER`, so this is safe and scoped to the call).
- Add keyset pagination: a `_after_symbol text` parameter so callers can walk the universe in ~400-symbol batches, returning the last symbol processed.
- Update `market-daily-sync` and `market-pipeline-eod` to loop that RPC in batches until it returns 0, instead of one 3,000-row shot.

### 3. Re-key the EOD candidate query on score staleness
In `market-pipeline-eod`, replace the `last_price_sync_at` filter with "symbols whose `market_stock_scores.trade_date` is behind the latest `market_daily_prices.trade_date`", keeping the 3-attempts-per-day guard. Prices-fresh-but-scores-stale symbols then get picked up and drained by the existing chunk loop.

### 4. Stop silent failures (industry-standard pipeline hygiene)
- `market-pipeline-eod` returns HTTP 500 (and `status: failed` in `market_ingestion_runs`) when `succeeded === 0 && failed > 0` — a 100%-failure chunk must not report `ok: true, drained: true`.
- Write a `market_provider_health` row on `PGRST204`/schema-drift errors, tagged `schema_drift`, so the next occurrence is visible instead of buried in metadata.
- Add a post-chain freshness assertion in `market-daily-sync`: after the chain, compare `max(market_stock_scores.trade_date)` to `max(market_daily_prices.trade_date)`; if behind, mark the summary row `failed` with the gap in metadata.

### 5. Daily-drain coverage
Add a `market-pipeline-eod` catch-up cron on the existing evening window (every 15 min, 14:00–19:00 UTC, Mon–Fri) so a single orchestrator run that hits its 40-iteration cap still finishes the universe the same day rather than waiting 24h.

### 6. Surface staleness in the UI
The Analysis rail chip already shows `EOD <date> · Nd old`. Add an amber tone to that chip (and the Screener header) when the score date is behind the latest available price date — a data-pipeline problem should look like one, not like a quiet timestamp.

### 7. Backfill once the fixes are in
Run the batched rescore across the full universe plus a forced `market-pipeline-eod` drain so all ~2,700 symbols land on Jul 31, then refresh the screener snapshot.

## Technical notes
- New migration file; no table creation, so no `GRANT` changes.
- Edge functions touched: `market-pipeline-eod`, `market-daily-sync`.
- RPC changed: `market_rescore_latest_from_prices` (added optional param, backward compatible).
- Frontend touched: the EOD-freshness chip in `src/routes/market/Analysis.tsx` and its Screener equivalent — presentation only.
