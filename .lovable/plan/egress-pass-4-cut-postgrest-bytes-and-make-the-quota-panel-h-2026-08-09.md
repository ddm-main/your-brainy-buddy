# Egress pass 4 — cut PostgREST bytes and make the quota panel honest

## Verified state (read from the live DB just now)

Free-plan sections today:

| Section | Now | Limit | Status |
|---|---|---|---|
| Database size | 200 MB | 500 MB | 40% — fine |
| File storage | ~0 MB | 1 GB | fine |
| Monthly active users | 3 | 50 000 | fine |
| Egress | see below | 5 GB | the only pressure point |

Measured egress per day (`system_egress_daily`):

- 2026-08-04: 460 MB, 2026-08-05: 320 MB, 2026-08-06: 190 MB, 2026-08-07: 90 MB,
  **2026-08-08: 26 MB, 2026-08-09: 17 MB (partial day)**.

So the earlier passes worked — the current run rate is ~25 MB/day (~750 MB/month),
already inside 5 GB. Two real problems remain.

**Problem 1 — the panel is showing a stale, wrong window.** `system_quota_state`
has `egress_cycle_day = 23` and a window of `2026-07-23 → 2026-08-08`, so it sums
the pre-fix days and reports **1.06 GB / 4 GB**. Supabase's own billing page
(screenshot) says the cycle is **08 Aug → 08 Sep, 0.09 GB used**. The counter is
not lying about bytes, it is summing the wrong month. Last sync was 08-08 06:04,
so it is also stale.

**Problem 2 — remaining heavy fetches.** Top routes on 08/09 Aug:

| route | per fetch | req/day | bytes/day |
|---|---|---|---|
| `market_screener_rows (26c)` | **210 KB** | 24–28 | 5.9 MB |
| `market_screener_rows (21c)` | **154 KB** | 26 | 4.0 MB |
| `srv:market_stock_scores` | 1.4 KB | 5 430 | 7.8 MB |
| `srv:market_stocks` | 0.5 KB | 7 181 | 3.3 MB |
| `srv:market_daily_prices` | 0.2 KB | 5 578 | 1.3 MB |
| `srv:market_api_settings` | 3.3 KB | 340 | 1.1 MB |
| `market_provider_health (4c)` | **10.5 KB** | 72 | 0.76 MB |
| `market_stock_scores (50c)` | 15 KB | 30 | 0.46 MB |

No single fetch exceeds 1 MB any more, but the screener still pulls the entire
1 827-row universe on every run, and the server-side loops make ~18 000 tiny
PostgREST round-trips a day (each carrying ~220 B of header overhead).

## The fix

### 1. Correct the billing cycle (makes the panel match Supabase)
- Set `egress_cycle_day` to **8** and re-run the rollup so the panel reports the
  current cycle only (~90 MB, matching the dashboard) instead of 1.06 GB.
- Have the rollup recompute the window from the cycle day on every run, and show
  "stale" in the panel when `egress_synced_at` is older than 12 h.
- Make the sync run on its own hourly cron rather than only riding `market-selftest`,
  so the number cannot go two days stale again.

### 2. Screener — stop shipping the whole universe (biggest per-fetch win)
- Server-side ordering already exists; add a **page size of 300 rows** for the
  visible board with cursor paging, so a normal screener open costs ~35 KB
  instead of 210 KB. Client-side filters that need the full universe request the
  remaining pages only when the user actually applies them.
- Cache the resolved page in react-query with a 15-minute `staleTime`
  (the snapshot itself only refreshes hourly).
- Expected: 10 MB/day → ~1.5 MB/day.

### 3. Server-side loops — batch the tiny reads
In `_shared/market/provider.ts` and the pipeline functions:
- Replace per-symbol `market_stock_scores` / `market_daily_prices` /
  `market_stocks` reads inside loops with chunked `.in("symbol", …200)` reads and
  an in-isolate `Map` cache for the run's duration.
- Raise the `market_api_settings` in-isolate TTL to 5 minutes (mutations already
  bypass the cache via `getFreshSettingsRow`).
- Expected: ~18 000 round-trips → under 2 000; 13 MB/day → ~3 MB/day.

### 4. Small readers
- `ProvidersPanel`: fetch 80 rows instead of 300, drop the `error` text from the
  list projection (fetch it only for the expanded provider), poll every 5 min.
- `HealthSparkline`: 40 points, `ok,latency_ms,created_at` only.
- `market_stock_scores (50c)` popover: fetch on open only, not with the board.

### 5. A guard so this cannot regress
- Extend the browser meter (`src/lib/egressMeter.ts`) to log a dev-console warning
  for any single response over **256 KB**, with the query key and byte count.
- Add the same threshold to `serverEgress.ts` for edge-function reads.
- Add a compact "top 5 routes today" line to the quota panel (it already shows the
  cycle total) so a new heavy read is visible the day it lands.

### 6. Verify
After the changes: re-read `system_egress_daily` for the next full day and confirm
the daily total lands under **10 MB/day** (~300 MB/cycle, 6% of the free 5 GB),
that no route shows a per-request figure above 256 KB, and that the panel's cycle
window and total match the Supabase billing page.

## Technical notes

Files: `supabase/functions/_shared/market/egress.ts` (cycle window),
`_shared/market/provider.ts` (batched reads, settings TTL),
`src/lib/market/screenerRun.ts` (paging), `src/components/config/ProvidersPanel.tsx`,
`src/components/config/providers/HealthSparkline.tsx`,
`src/components/config/DatabaseStoragePanel.tsx` (top-routes line, stale badge),
`src/lib/egressMeter.ts` + `_shared/market/serverEgress.ts` (oversize warning).
One small migration: set `egress_cycle_day = 8` and schedule the hourly egress
rollup job. No schema changes, no behaviour change — same data, fewer bytes.
