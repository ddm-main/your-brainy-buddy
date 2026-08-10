# Cut PostgREST egress to the floor

A fresh pass over `system_egress_daily` (08–10 Aug) shows where the ~60 MB
actually went. Two causes dominate, and neither is "the app fetched data it
needed" — one is writes echoing rows back, the other is the screener refetching
the same universe every time a column or filter changes.

## What the numbers say

| Route | Total | Requests | Per fetch |
|---|---|---|---|
| `srv:market_stocks` (untagged, no `select`) | 19.6 MB | 14,466 | 1.4 KB |
| `market_screener_rows` (client, 21c + 26c + 27c) | 26.5 MB | ~190 | 112–219 KB |
| `srv:market_stock_scores` (untagged, no `select`) | 8.6 MB | 8,127 | 1.1 KB |
| `srv:market-live-sweep market_stocks` (1c/4c/5c) | 27.5 MB | 1,883 | 9–22 KB |
| `srv:market-quotes market_api_settings (23c)` | 3.9 MB | 1,007 | 3.9 KB |
| `srv:market-pipeline-aggregates market_stock_scores` | 31.4 MB | 26 | 1.2 MB |

## 1. Writes are shipping the whole row back (≈28 MB)

The untagged `market_stocks` / `market_stock_scores` rows carry no `select=`
parameter, so they are not reads at all — they are `update`/`upsert` calls, and
a ~1.3 KB average means PostgREST is returning the written row instead of an
empty 204. 22,600 writes a day paying full row size for an answer nothing reads.

- Confirm the response body on one write path (single PATCH, measure bytes).
- Make "no body" the default for the service client: request
  `Prefer: return=minimal` globally, so any write that does not explicitly ask
  for rows returns 204. Calls that legitimately chain `.select()` override the
  header per request and keep working.
- Sweep the per-symbol update loops (`market-fundamentals-global-sync`,
  `parity.ts`, `market-shares-outstanding-sync`) and confirm none of them read
  the returned row.

Expected: ~28 MB → under 5 MB (header overhead only).

## 2. The screener refetches the universe on every column/filter change (≈26 MB)

`useScreenerData` keys both planes on `projection.key` and `capKey`. Every
column toggle, every filter add/remove and every flip to "load all" is a brand
new key, so both planes are pulled again from scratch — 3–4 visits produced
~190 full-universe fetches.

- Fetch one fixed superset per plane (`STATIC_FULL` / `LIVE_FULL`) and project
  the columns the screen needs in memory. Narrowing columns no longer changes
  the query key, so a filter tweak costs zero bytes.
- Key the static plane on universe only and keep the 6 h localStorage cache;
  one static fetch per session, not per projection.
- Treat the row cap as a superset too: once the full universe is in cache,
  "load all" and the 300-row board are served from the same data.

Expected: ~26 MB → ~0.4 MB per session (one static + one live pull, then a live
poll every 5 min while the market is open).

## 3. Verify the live-sweep snapshot actually landed (≈27 MB)

The per-session snapshot that replaces the per-chunk universe reads is written
but `market_sweep_snapshot` is still empty (no sweep has run since deploy).
Check the first sweep of the next session: one snapshot row, chunk reads only,
and no `market-live-sweep market_stocks` route in `system_egress_daily`. If the
row is missing, the build path is failing silently and needs the error surfaced.

## 4. Settings row re-read on every invocation (≈8 MB)

`market_api_settings` is pulled 2,600+ times a day across `market-quotes`,
`market-live-sweep`, `market-indices`, `market-orders` and `market-autotrade-eval`
at 3–5 KB a hit, because the row carries encrypted token blobs. Project only the
fields each caller uses and memoise it per isolate for its warm lifetime.

## 5. Keep the 1 MB ceiling honest

`market-pipeline-aggregates` is the only route that ever crossed 1 MB and is now
paged at 200 rows with alias + jsonb-key projection. Add a guard so any single
response above 1 MB is recorded in `system_maintenance_log`, not just logged to
a console nobody reads — a regression should show up as a row, not a memory.

## Technical notes

- Files: `supabase/functions/_shared/market/common.ts` (client Prefer header),
  `src/lib/market/screenerRun.ts` (plane keys, superset cache),
  `supabase/functions/_shared/market/serverEgress.ts` (ceiling record),
  the settings readers listed above.
- No schema change, no behaviour change on screen: the screener still renders
  and filters exactly the same values, it just stops re-downloading them.
- Verification is the same query used above — `system_egress_daily` grouped by
  route, before and after a full trading session.
