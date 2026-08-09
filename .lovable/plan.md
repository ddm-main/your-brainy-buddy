# Egress pass 5 — get every fetch far under 1 MB and keep all four free-plan meters green

## Verified state (read from the live DB just now)

Daily measured egress (`system_egress_daily`):

| Day | Total | Requests |
|---|---|---|
| 04 Aug | 442 MB | 39 k |
| 06 Aug | 195 MB | 113 k |
| 07 Aug | 86 MB | 36 k |
| 08 Aug | 25 MB | 25 k |
| 09 Aug (partial) | 16 MB | 12 k |

The earlier passes worked: the run rate is now ~20 MB/day. `system_quota_state`
already has `egress_cycle_day = 8`, window 08-08 → 08-09, 43 MB measured, last
synced today 18:16 UTC — that matches the Supabase billing page (0.09 GB used,
08 Aug → 08 Sep). No fetch anywhere is above 1 MB today; the largest single
response is 206 KB.

Free-plan sections right now:

| Section | Now | Limit | Status |
|---|---|---|---|
| Egress | 86 MB (Supabase) / 43 MB measured | 5 GB | ~2% |
| Database size | 210 MB instance disk (tables total ~160 MB) | 500 MB | 42% |
| Monthly active users | 1–3 | 50 000 | fine |
| File storage | ~0 MB | 1 GB | fine |

Biggest remaining consumers (08–09 Aug):

| Route | Per fetch | Req/day | Bytes/day |
|---|---|---|---|
| `market_screener_rows (26c)` | **206 KB** | 24–28 | 5.9 MB |
| `market_screener_rows (21c)` | **154 KB** | 26 | 4.0 MB |
| `srv:market_stock_scores` | 1.4 KB | 5 430 | 7.8 MB |
| `srv:market_daily_prices` | 0.2 KB | 5 578 | 1.3 MB |
| `srv:market_stocks` | 0.5 KB | 2 900–7 200 | 1.6–3.3 MB |
| `market_provider_health (4c)` | **10.5 KB** | 72 | 0.76 MB |
| `srv:market_api_settings` | 3.3 KB | 334 | 0.7 MB |

Two structural problems remain: the screener still pulls the whole ~1 800-row
universe in one shot on both planes, and the edge-function pipelines still make
~14 000 tiny PostgREST round-trips a day (each carrying ~220 B of header
overhead on top of a sub-KB body).

## The fix

### 1. Screener — page the board instead of shipping the universe
`src/lib/market/screenerRun.ts` fetches 1 000 rows per range call with no cap.
- Fetch the **first 300 rows** for the visible board (server-ordered by
  `breakout_score`, already the case), then load further pages lazily only when
  the user scrolls, sorts on a column the server can order by, or applies a
  filter that needs the full plane.
- CSV export and full-universe filters become an explicit "load all" path.
- Keep the two-plane split; the statics plane already has a 6 h localStorage
  cache, so add the same session cache to the first live page.
- Expected: 206 KB → ~35 KB per open; 10 MB/day → ~1.5 MB/day.

### 2. Server pipelines — batch the tiny reads
In `supabase/functions/_shared/market/provider.ts` and the pipeline functions:
- Replace per-symbol reads of `market_stock_scores`, `market_daily_prices`,
  `market_stocks` and `market_shares_outstanding` inside loops with chunked
  `.in("symbol", …200)` reads plus an in-isolate `Map` cache for the run.
- Raise the `market_api_settings` in-isolate TTL to 5 minutes (mutations keep
  using the fresh accessor).
- Expected: ~14 000 round-trips → under 2 000; ~11 MB/day → ~2 MB/day.

### 3. Small readers
- `ProvidersPanel`: 80 rows instead of 300, drop the `error` text from the list
  projection (fetch it only for the expanded provider), poll every 5 min.
- `HealthSparkline`: 40 points, `ok,latency_ms,created_at` only.
- `market_stock_scores (50c)` popover: fetch on open, not with the board.
- `market-candles` (11 MB on 06 Aug): cap returned bars per interval and drop
  unused columns from the payload.

### 4. Tighten the guard so this cannot regress
- Lower the browser meter's hard ceiling in `src/lib/egressMeter.ts` from
  400 KB to **128 KB** (warn at 64 KB) and mirror it in
  `_shared/market/serverEgress.ts`, so any oversized read is named in
  `system_egress_daily` the day it lands.
- Add a "requests/day" ceiling alert: any route over 2 000 requests/day gets
  flagged in the quota panel's top-routes list as a batching bug.

### 5. Keep the other three meters honest
- **Database (42%)**: `market_live_price_stage` (47 MB) is a staging table —
  add a retention prune to `run_daily_maintenance` so it keeps only the current
  session; trim `market_indicators_cache` (30 MB) to the symbols still tracked.
- **Storage / MAU**: no action needed; surface both in the same top-routes
  panel so drift is visible.
- Show a stale badge on the panel when `egress_synced_at` is older than 12 h.

### 6. Verify
After the changes, re-read `system_egress_daily` for the next full day and
confirm: daily total under **8 MB/day** (~250 MB/cycle, 5% of 5 GB), no route
above 128 KB per request, no route above 2 000 requests/day, database under
400 MB, and the panel's cycle window and total matching the Supabase billing
page.

## Technical notes

Files: `src/lib/market/screenerRun.ts` (paging), `src/routes/market/Screener.tsx`
(load-more / export path), `src/components/config/ProvidersPanel.tsx`,
`src/components/config/providers/HealthSparkline.tsx`,
`src/components/config/DatabaseStoragePanel.tsx` (top routes, stale badge),
`src/lib/egressMeter.ts` and `supabase/functions/_shared/market/serverEgress.ts`
(thresholds), `_shared/market/provider.ts` and the pipeline functions (batched
reads, settings TTL), `supabase/functions/market-candles/index.ts` (bar cap).
One migration: retention prune for `market_live_price_stage` and
`market_indicators_cache` inside `run_daily_maintenance`. No schema changes to
user-facing tables, no change to displayed values — same data, fewer bytes.
