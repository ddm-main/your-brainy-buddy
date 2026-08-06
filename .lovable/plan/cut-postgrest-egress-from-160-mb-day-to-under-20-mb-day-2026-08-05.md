# Cut PostgREST Egress from ~160 MB/day to under 20 MB/day

## Status check before building

Confirmed against the current code: the build guard from Stage 1 already shipped (`src/lib/buildGuard.ts`, installed in `src/main.tsx`) — it polls `index.html` and hard-reloads stale tabs, which is what was bleeding 141 MB/day. The rest of Stage 1 (query-key bump, oversized-response guard in `egressMeter.ts`), and all of Stages 2–4, are not in the codebase yet. There is no `market_screener_page` RPC and no settings cache helper in `supabase/functions/_shared/market/`.

## What the data says

| Day | Route | Requests | Bytes | Per request |
|---|---|---|---|---|
| 08-05 | `market_screener_rows (108c)` | 162 | **141 MB** | 872 KB |
| 08-05 | `srv:market_stocks` | 7,739 | 33 MB | 4.3 KB |
| 08-05 | `rpc/market_live_settled_anchors` | 428 | 13.7 MB | 32 KB |
| 08-05 | `market_stock_scores (4c)` | 340 | 10 MB | 29 KB |
| 08-05 | `object/market-archive/NSE` (storage) | 1,470 | 9.6 MB | 6.5 KB |
| 08-05 | `market_screener_rows (32c)` | 27 | 6.9 MB | 254 KB |
| 08-05 | `market_api_settings` | 1,492 | 5.8 MB | 3.9 KB |
| 08-05 | `market_screener_rows (76c)` | 9 | 5.3 MB | 594 KB |

The 108-column route is a pre-split cached bundle (76 + 32 = 108); nothing in the repo builds it. The remaining structural cost is the screener pulling the whole 2,837-row universe to filter in the browser.

## The plan

### Stage 1 — Finish stopping the stale-bundle bleed
- Bump the react-query key versions (`screener-static-v1` → `v2`, `screener-live-v1` → `v2`) so any persisted cache from an old bundle is discarded.
- Add a guard in `egressMeter.ts`: any single response over 400 KB is logged and surfaced in the HUD dev overlay, so a regression like this is visible the same day.

### Stage 2 — Server-side screener filtering and pagination (~594 KB → ~20 KB per action)
- New RPC `market_screener_page(_filters jsonb, _universe text, _order text, _desc bool, _limit int, _offset int)` that applies the filter predicates, ordering and `LIMIT/OFFSET` in Postgres and returns the page plus a total count.
- Project only the columns the active filters and visible preset need — `colsFromActiveFilters` becomes the server projection instead of a display-time filter.
- `useScreenerData` keeps the two-plane cache for the no-filter default view; any active filter or page change routes through the RPC.
- CSV export stays full-universe but becomes an explicit action with its own RPC call.

### Stage 3 — Cut the server-side request count
- `srv:market_stocks` (7,739 req/day): replace per-symbol lookups in the sync functions with one batched symbol→metadata fetch per invocation, held in module scope.
- `market_api_settings` (1,492 req/day): add a cached accessor in `supabase/functions/_shared/market/` with a short in-memory TTL and use it everywhere the row is read inline today.
- `rpc/market_live_settled_anchors`: return only `symbol, prev_close` for the symbols in the current sweep chunk instead of the full anchor set per chunk.
- `mergeV4Scores`: fold the v4 score into the `market_screener_rows` view so it arrives with the static plane instead of 6 chunked round-trips.

### Stage 4 — Budget enforcement and verification
- Extend `apply_egress_governor()` to trip the low-bandwidth brake at a daily 20 MB threshold, not just the monthly budget percentage.
- Add a per-route ceiling to the egress meter so any route averaging over 1 MB/request is reported.
- Verify in the running app: load the Screener, apply the Market cap / Close / 1D return / Volume filter set, page through results, and confirm from `system_egress_daily` that each action stays under 1 MB and the day trends under 20 MB.

## Technical notes
- Files touched: `src/lib/market/screenerRun.ts`, `src/lib/market/hooks.ts`, `src/lib/egressMeter.ts`, `src/routes/market/Screener.tsx`, `supabase/functions/_shared/market/` (new settings cache), `market-live-sweep`, and the sync functions reading `market_stocks`.
- New migrations: the `market_screener_page` RPC, a `market_screener_rows` view revision adding `breakout_score_v4`, and the `apply_egress_governor` daily-threshold change. Each new function gets explicit `GRANT EXECUTE`.
- No change to displayed values: the RPC evaluates the same predicates against the same view, so screener output stays identical.
