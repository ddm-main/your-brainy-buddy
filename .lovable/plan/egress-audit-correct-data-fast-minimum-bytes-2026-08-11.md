# Egress audit — correct data, fast, minimum bytes

## Measured today (2026-08-11, server-side PostgREST, partial day: 25.3 MB)

| Route | Req | Bytes | KB/req |
|---|---|---|---|
| `market-live-sweep market_sweep_snapshot (1c)` | 243 | 15.7 MB | 63 |
| `market-live-sweep market_daily_prices (5c)` | 1,106 | 2.1 MB | 1.9 |
| `market-live-sweep market_api_settings (17c)` | 240 | 0.9 MB | 3.7 |
| `market-autotrade-eval market_api_settings (16c)` | 233 | 0.87 MB | 3.6 |
| `market-archive-prices` storage objects | 2,052 | 0.80 MB | 0.4 |
| `market-history-backfill` writes echoing rows | 4,055 | 0.89 MB | 0.2 |
| `market-live-sweep market_universe (6c)` | 2 | 0.24 MB | 131 / 108 |

Browser traffic today is 0.36 MB. The problem is entirely server-side cron.

Yesterday's shape (for reference): pipeline-aggregates pulled `market_stock_scores` 76 columns at 1.18 MB per page (31 MB), and unlabelled `market_stocks` reads cost 14 MB.

## What is actually wrong

1. **The sweep snapshot is now the single biggest line item.** The watched universe is 169 symbols in ONE chunk, so `payload->c0` ships the whole 63 KB blob on every invocation. On disk that same payload is 8.9 KB — the JSON-object encoding (`{"s":…,"y":…,"se":…,"sh":…}` per symbol plus a per-symbol `kotak` object) is roughly 4x fatter than it needs to be.
2. **Reads outnumber sweeps ~4:1.** 65 sweep runs were recorded today but 243 snapshot reads happened. Some invocation path reads the snapshot without recording a run (preflight/no-op/retry). Unverified which — first step is to instrument it.
3. **Per-invocation reference reads never amortise.** Every cold invocation re-reads `market_api_settings` (3.7 KB) and, on any feed miss, the index closes from `market_daily_prices`. The isolate caches exist but cold chains defeat them.
4. **Two per-minute crons** (`market-alerts-eval`, `market-autotrade-eval`, `* 3-10 * * 1-5` = ~480 runs/day each) pay a settings read even when there is nothing armed to evaluate.
5. **Writes still echo rows** on the history-backfill path (4,000 responses/day of returned data for inserts/patches).
6. **Aggregates still pages fat score rows** (76 columns) instead of aggregating in SQL — the only route that has ever crossed 1 MB per response.
7. **`market_universe` full read at 108–131 KB** happens inside the sweep even though the sweep only needs the watched subset.

## The fixes, ordered by bytes saved

### 1. Compact + de-duplicate the snapshot read (~14 MB/day)
- Re-encode the payload columnar: parallel arrays (`syms[]`, `yah[]`, `ser[]`, `sh[]`, `anch[]`, `tok[]`, `seg[]`) instead of one object per symbol; intern the repeated `nse_cm` segment and drop null fields. Expect ~63 KB → ~12 KB per read.
- Cap chunk size at 200 symbols so a chunk read stays small as the watched set grows, and address it as `payload->cN`.
- Add a per-isolate memo keyed by `session_date + watch_hash + chunk`, so warm chains read once.
- Find and remove the extra snapshot reads (243 reads vs 65 sweeps): log the invocation path in `market_live_price_runs` for one session, then short-circuit the paths that read the snapshot before deciding they have no work (market closed, no watched symbols, duplicate sweep already in flight).

### 2. Settings accessor with a real TTL (~1.8 MB/day)
One shared `_shared/market/settingsCache.ts`: narrow column list per caller (no `*_enc` blobs unless the caller signs a broker request), 5-minute TTL in isolate, and a single-row `maybeSingle()`. Callers: `market-live-sweep`, `market-autotrade-eval`, `market-quotes`, `market-orders`, `market-indices`, `market-history-backfill`.

### 3. Fold index closes into the sweep snapshot (~2 MB/day)
The `fromStoredClose` fallback fires on nearly every call. Resolve the handful of index closes once when the snapshot is built and read them from the chunk, removing 1,100 `market_daily_prices` reads/day.

### 4. Make the per-minute crons cheap when idle (~1 MB/day)
Both eval functions start with one tiny existence probe (`select id … limit 1` on armed rules / active alerts, `head: true` count) before touching settings or providers. No armed work, no provider read, no settings read.

### 5. Stop echoing writes everywhere (~0.9 MB/day)
`Prefer: return=minimal` is the client default now, but `market-history-backfill` still returns rows on `[POST]`/`[PATCH+sel]`. Drop the `.select()` from those calls.

### 6. Aggregates: aggregate in SQL, not in JS (~30 MB on aggregate days)
Replace the 76-column `market_stock_scores` paging in `market-pipeline-aggregates` with a security-definer RPC returning finished breadth / sector-strength / RS-rank rows. The tracker pass keeps a narrow projection over candidate rows only. Same numbers, a few KB instead of 31 MB.

### 7. Universe reads through `market_universe`, narrowed
The sweep should not read the whole `market_universe` (131 KB). It already has `market_live_watch_universe()`; make that the only universe source in the sweep, and switch the remaining `market_stocks` readers (`market-pipeline-eod`, `market-quotes`, `market-close-snapshot`, `market-history-backfill`) to `market_universe` with explicit column lists so penny rows (36% of the table) never cross the wire.

### 8. Keep the ceiling honest
The 1 MB gate already blocks and logs. Add a lower server budget line: any route above 128 KB per response writes a `system_maintenance_log` warning once per day, and the quota panel surfaces the top three offenders so a regression is caught the same day.

## Expected result
Server PostgREST on an idle logged-in day: ~25 MB → **under 4 MB**. No route above ~15 KB per response outside the once-daily aggregate pass. No displayed value changes anywhere — same predicates and same rows, fewer columns and fewer round trips.

## Technical notes
- Files: `_shared/market/sweepSnapshot.ts`, `_shared/market/indexQuotes.ts`, new `_shared/market/settingsCache.ts`, `market-live-sweep/index.ts`, `market-autotrade-eval`, `market-alerts-eval`, `market-history-backfill`, `market-quotes`, `market-orders`, `market-indices`, `market-pipeline-aggregates`, `market-pipeline-eod`, `market-close-snapshot`, `_shared/market/serverEgress.ts`.
- Migrations: aggregates RPC (with `GRANT EXECUTE`), optional `chunk_index` column on `market_sweep_snapshot` if per-chunk rows beat jsonb projection in measurement.
- Verification: after one full trading session, re-read `system_egress_daily` and confirm no `!OVER` rows, sweep snapshot bytes under 1 MB/day, and the Overview / Screener / Breakout pages showing identical values.
