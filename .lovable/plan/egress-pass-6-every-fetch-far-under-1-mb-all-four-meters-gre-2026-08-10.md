# Egress pass 6 — every fetch far under 1 MB, all four meters green

## Verified state (read from the live DB just now, 10 Aug 11:08 IST)

Daily measured totals (`system_egress_daily`):

| Day | Bytes | Requests |
|---|---|---|
| 04 Aug | 463 MB | 39 k |
| 06 Aug | 204 MB | 113 k |
| 07 Aug | 90 MB | 36 k |
| 08 Aug | 26 MB | 25 k |
| 09 Aug | 24 MB | 19 k |
| 10 Aug (to 11:08 IST) | **19.6 MB** | 11 k |

Good news, confirmed: no single fetch today is anywhere near 1 MB, and the
screener rows route (210 KB/fetch, ~10 MB/day on 08–09 Aug) has disappeared
from today's table entirely — the paging change did its job.

Bad news, also confirmed: today is on pace for ~45 MB, worse than yesterday,
and the cause is one route.

Top routes today:

| Route | Req | KB/req | Bytes |
|---|---|---|---|
| `srv:market_stocks` | 2 160 | **5.6** | **12.4 MB** |
| `srv:rpc/market_live_settled_anchors_lean` | 155 | 16.6 | 2.6 MB |
| `srv:market_daily_prices` | 3 167 | 0.5 | 1.5 MB |
| `srv:market_api_settings` | 372 | 3.4 | 1.3 MB |
| `srv:object/market-archive/NSE` | 1 797 | 0.3 | 0.6 MB |

`srv:market_stocks` was 0.47 KB/req yesterday and is 5.6 KB/req today — a 12x
per-request jump. The route label only carries the table name, so which of the
~20 edge functions that read `market_stocks` regressed cannot be proven from the
data. Diagnosis is therefore **unconfirmed** and step 1 is to make it
attributable, not to guess.

The other three meters (database size, storage, MAU) could not be re-read this
turn: `quota_report()` is `service_role`-only and the read-only SQL role is
denied `EXECUTE`. They are checked in-app in step 5.

## The plan

### 1. Make server egress attributable (do this first)
In `supabase/functions/_shared/market/serverEgress.ts`, extend the route label
with the caller and the shape of the read:
- prefix with the function name (`SB_EXECUTION_ID` is not stable; use a module
  constant each function already knows, falling back to the request path),
- append the selected column count parsed from the `select=` query param, the
  same way the browser meter already writes `(26c)`,
- append `~Nk` request-count-free size bucket so a route that doubles is obvious.

Result: `srv:market-live-sweep market_stocks (5c)` instead of
`srv:market_stocks`. Then re-read `system_egress_daily` and name the offender
before changing any pipeline.

### 2. Fix the named offender
Once step 1 names it, apply the matching cut. The likely candidates and their
fixes, all verified as present in the code:
- `market-pipeline-eod` selects 8 columns of `market_stocks` per chunk plus a
  second `addFromStocks` read with the same 8 columns — drop to the 4 the loop
  actually uses and reuse the first result instead of re-reading.
- `market-live-sweep` selects 5 columns for up to 600 symbols per chunk, every
  chunk of every 5-minute sweep — cache the static part
  (`yahoo_symbol,series,total_shares_cr`) in an isolate `Map` keyed by symbol so
  only the keyset page of symbols is re-read.
- `market-archive-prices` prune mode pages the full penny list and the full
  archive index on every run — move that set difference into SQL and return only
  the doomed object paths.

### 3. Trim the two mid-size routes
- `market_live_settled_anchors_lean` at 16.6 KB/call: the RPC returns numeric
  `prev_close` as text per row; round to 2 dp and drop rows whose anchor equals
  the caller's cached value by passing a `_since` timestamp, so a mid-session
  chunk returns a delta, not the whole chunk.
- `market_api_settings` at 3.4 KB/call × 372: the row is wide. The cached
  accessor should select only the keys the callers read, and its TTL should
  apply to the read path in every function (some still read the row inline).

### 4. Cut the request counts
`market_daily_prices` (3 167) and `object/market-archive/NSE` (1 797) are cheap
per call but carry ~220 B of header overhead each. Batch both into chunked
`.in(...)` reads / one archive fetch per symbol-range, targeting under 1 000
requests/day each.

### 5. Verify all four meters, in-app
- Open Config → System & Data and read the quota panel (it calls `quota_report`
  as an authenticated admin, which the SQL role cannot): confirm database under
  400 MB, storage and MAU nominal, egress cycle total matching the Supabase
  billing page.
- Re-read `system_egress_daily` after one full day and require: total under
  **8 MB/day**, no route above **128 KB/request**, no route above **2 000
  requests/day**.
- If any route still trips the ceiling, the `!OVER` tag from the guard names it
  directly — there is already one such row (`srv:market_stock_scores !OVER`,
  3.5 MB in a single response on 09 Aug) that this pass must also clear.

## Technical notes

Files: `supabase/functions/_shared/market/serverEgress.ts` (attribution),
`_shared/market/settings.ts` (narrow projection + TTL on all read paths),
`market-pipeline-eod`, `market-live-sweep`, `market-archive-prices`,
`market-close-snapshot` (column trims and isolate caching). One migration for
the `market_live_settled_anchors_lean` delta parameter and a SQL-side penny/
archive set difference; both get explicit `GRANT EXECUTE` to `service_role`.
No schema changes to user-facing tables and no change to any displayed value —
same data, fewer bytes.
