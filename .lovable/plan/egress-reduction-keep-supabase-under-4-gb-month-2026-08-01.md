# Egress reduction — keep Supabase under 4 GB / month

Current cycle (23 Jul – 23 Aug): **4.95 GB of 5 GB used**, and the daily chart shows
300 MB – 1.2 GB per day, almost all of it green (Database/API). Target: < 4 GB per
cycle, i.e. ~130 MB/day average.

## What the reads confirmed

**1. The screener full-table pull is the single biggest source.**
`useScreenerData` → `fetchScreenerRows()` pages the whole `market_screener_rows`
view (2 831 rows) with a 78-column projection, then `mergeV4Scores()` pages
`market_stock_scores` (2 927 rows) on top. Measured on the live table:
avg **4 045 bytes of JSON per row → ~11 MB per full fetch**. Two of those
columns are jsonb blobs the table barely uses: `score_components` (avg 616 B)
and `data_provenance` (avg 609 B).

Where it fires:
- `/market/screener` on every mount, with `staleTime: 60_000` (a tab left open
  and refocused re-pulls 11 MB per minute of activity).
- `/market/breakout` (same hook).
- `/market/dashboard` whenever a saved screen is selected.

Ten screener visits ≈ 110 MB. This alone explains the 1.2 GB day.

**2. `useStockScores` selects `*` from `market_stock_scores`** (109 columns,
25 MB table, ~8.5 KB/row). The Dashboard calls it twice on mount
(limit 60 + limit 10 ≈ 600 KB) for cards that render ~10 fields.

**3. Live polling.** Dashboard portfolio quotes poll `market-quotes` every
**1 s** while NSE is open (`refetchInterval: () => nseOpenNow() ? 1_000 : false`),
and `hooks.ts` has more 1 s / 10 s / 15 s pollers (quotes, orders, positions,
funds, autotrade). 1 s for 6.25 open hours = 22 500 responses/day per open tab.

**4. Realtime tick broadcast.** One private channel fans out up to 100 symbols
of Kotak ticks to the browser continuously during market hours — counted as
Realtime egress with no throttle or visibility gate.

**5. Cron overlap.** `refresh_market_screener_snapshot()` is scheduled three
times (`*/10`, `*/15`, and post-close) — pure duplicate work; and
`market-archive-prices` drains every 5 minutes even though the backlog is
essentially done (2 156 objects, 6.3 MB total), each symbol doing a storage
download for merge **plus a second download to verify**.

## The fix

### A. Screener — stop shipping the whole universe (biggest win, ~80% cut)
1. Drop `score_components` and `data_provenance` from `SCREENER_COLUMNS`; load
   `score_components` lazily per symbol where the score popover/explain page
   needs it. (−1.2 KB/row ≈ −3.4 MB per fetch.)
2. Trim the projection to the columns the table + filters actually read; move
   rarely-used fundamentals to a second on-demand fetch when a fundamental
   filter or column is enabled.
3. Fold the v4 merge into the source view (`market_screener_rows` gains
   `breakout_score_v4` and a scalar `breakout_v4_score_buckets`), removing the
   entire second 2 927-row pass.
4. Push universe filtering server-side (`is_nifty500` / `fno_enabled` / `sme` /
   index membership as query filters) instead of fetching "all" and filtering
   in the browser.
5. Raise `staleTime` to 15 min for the live branch, set
   `refetchOnWindowFocus: false` and `refetchOnMount: false`, and share one
   cache entry across Screener/Breakout/Dashboard.

Expected: ~11 MB → **~1.5–2 MB** per screener load, fetched far less often.

### B. Column projections everywhere `select("*")` is used
`useStockScores`, `market_positions`, `market_holdings`, `market_breadth_daily`,
`market_sector_strength_daily`, `market_api_settings`, `market_top_movers`,
`market_index_watch` — replace with explicit column lists matching what the UI
renders.

### C. Poll cadence + visibility gating
- Dashboard portfolio quotes: 1 s → 3 s, and pause when the document is hidden
  (add `refetchIntervalInBackground: false`, which it currently lacks).
- Standardise the live cadence helper: quotes 3 s, orders/positions 10 s,
  funds/autotrade 30 s, everything non-trading 60 s+.
- Gate all market pollers on `document.visibilityState === "visible"`.

### D. Realtime ticks
- Unsubscribe the relay channel when the tab is hidden for > 60 s and resubscribe
  on focus.
- Lower the symbol cap from 100 to the symbols actually on screen, and have the
  relay coalesce ticks to at most 1 update per symbol per second.

### E. Cron / server-side
- Delete the duplicate screener-snapshot jobs; keep one `*/15` intraday job plus
  the post-close run.
- `market-archive-prices` drain: `*/5` → hourly, and drop the redundant verify
  re-download (check the upload response instead).
- Keep `market-tick-bars` at 1 min but confirm it writes only deltas.

### F. Measurement
Add a lightweight dev-only counter that logs bytes received per query key, so
we can verify the reduction instead of guessing, and surface the current cycle's
egress in the existing quota panel from `system_quota_state`.

## Order of work
1. A (screener projection + view merge + cache) — the 80% win.
2. C + D (polling and realtime) — the "always-on tab" drip.
3. B (projections), E (cron), F (measurement).

## Technical notes
- Files: `src/lib/market/screenerRun.ts`, `src/lib/market/hooks.ts`,
  `src/routes/market/Dashboard.tsx`, `src/lib/market/useRealtimeTicks.ts`,
  `supabase/functions/market-archive-prices/index.ts`, plus one migration for
  the `market_screener_rows` view and the cron changes.
- No behaviour change intended: same rows, same numbers, fewer bytes and fewer
  requests.
