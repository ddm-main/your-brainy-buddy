# Screener "90 no quote" — root cause and full pipeline repair

## What the chip is telling you

`1,351/1,441 priced · 90 no quote` means: of the 1,441 active NSE equities in the screener snapshot, 90 rows carry **no trade_date at all** — the screener therefore can't judge them on price / 1D return / volume and excludes them from those filters.

## Root cause (confirmed against the live database)

The 90 symbols are **not** missing data. Every one of them has a `market_daily_prices` row for 2026-08-11 and a score row. The problem is ordering:

| Time (UTC, 2026-08-11) | Event |
|---|---|
| 17:59 | penny sweep flags 1,256 symbols, refreshes the screener snapshot |
| 18:18 | penny sweep runs again, flags 0 — universe back to 1,441 (only 1 symbol still flagged) |
| 18:41 | last snapshot refresh (`market_screener_snapshot.refreshed_at`) |
| 18:45 / 19:04 | NSE bhavcopy + master sync write today's prices for the remaining symbols |

`refresh_market_screener_snapshot()` is only called from inside the **penny sweep** path. The daily sync chain (`nse-bhavcopy-sync` → `promote-market-eod-session` → `rescore-from-prices`) never refreshes it, so any symbol whose price lands after the last penny sweep sits in the snapshot with `trade_date = NULL` until the next unrelated job happens to rebuild it. Those 90 rows are exactly that.

Three further problems surfaced while confirming this:

1. **Scores are half-covered** — 1,440 price rows for 2026-08-11 but only 920 score rows (520 still on 2026-08-10). The rescore step reports `ok` while leaving the session mixed.
2. **Live sweeps have failed every run today** — `coverage below promotion floor (169/2656)`. The run's denominator comes from `market_live_sweep_universe()` (2,656 rows, and it moved 1,710 → 2,656 today as the penny flags flipped), while the sweep actually scans and prices only 169 symbols. The live plane is therefore never promoted.
3. **Egress ceiling breaches** — the console shows `market_screener_rows → 237.3 KB` and `176.2 KB` against a 128 KB ceiling: a full-plane screener read ships the whole 1,441-row universe with 22–27 columns.

## Fix

### 1. Snapshot freshness (this is the 90)
- Refresh the screener snapshot as the **final step of the daily sync chain**, after prices are promoted and scores are rebuilt — not only as a side effect of the penny sweep.
- Make the refresh idempotent and cheap enough to also run at the end of `market-close-snapshot`.
- Record `refreshed_at` and the row count on `market_ingestion_runs` so a stale snapshot is visible instead of surfacing as a mystery "no quote" count.

### 2. Never show a null session where a price exists
- Extend the snapshot/view fallback so `trade_date` resolves from the newest available price row rather than being left NULL when the snapshot lags. This makes the chip degrade to "slightly stale" instead of "no quote".

### 3. Finish the rescore
- Drive `market_rescore_prices_batch` to actual exhaustion for the session (loop until `processed = 0`), and record processed/remaining on the run row. Report `error` when the session ends with fewer scored symbols than priced symbols, instead of a silent `ok`.

### 4. Live sweep denominator
- Measure promotion coverage against the population the sweep actually stages, not `market_live_sweep_universe()`'s raw count, and store numerator + denominator on `market_live_price_runs`.
- Investigate first (unconfirmed): the run opens with `expected_count = 2656` but only 169 symbols are ever handed out in chunks, so either the snapshot build or the chunk reader is truncating the universe. That has to be diagnosed before the floor is touched — lowering the floor over a truncated sweep would promote a 6% plane.

### 5. Penny-flag instability
- 1,256 symbols were flagged then un-flagged within 20 minutes, and sub-₹50 names (e.g. 3PLAND ₹32, BCG ₹9.88) currently sit inside the universe with only 1 symbol flagged. Identify which writer resets `penny_excluded` after the sweep and make the sweep's decision durable, so the universe size (and every coverage denominator built on it) stops oscillating.

### 6. Egress
- Cap the default screener plane read so a no-filter open cannot exceed the 128 KB ceiling: page the full plane in ≤ 800-row slices and drop columns the board does not render until a filter/export actually needs them.

## Technical notes

- **DB migration**: add the snapshot refresh + reporting to the daily chain path; add coverage numerator/denominator columns to `market_live_price_runs`; adjust the `trade_date` fallback in `market_screener_live` / `market_screener_rows`.
- **Edge functions**: `market-daily-sync` (final snapshot refresh, rescore-to-exhaustion, honest status), `market-close-snapshot` (same refresh at the end), `market-live-sweep` (coverage instrumentation after the truncation diagnosis).
- **Frontend**: `src/lib/market/screenerRun.ts` (page size + projection trim). The chip in `Screener.tsx` needs no change — it is reporting the truth.

## Order of work

1. Snapshot refresh at the end of the daily chain + immediate manual refresh → the 90 disappear today.
2. Rescore to exhaustion → scores stop lagging prices.
3. Diagnose the 169-symbol sweep truncation, then fix the coverage math.
4. Penny-flag durability.
5. Egress trim.
