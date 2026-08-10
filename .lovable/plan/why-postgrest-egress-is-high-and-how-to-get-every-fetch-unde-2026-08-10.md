# Why PostgREST egress is high — and how to get every fetch under 1 MB

## What the measurements actually say

Your browsing is not the cause. Split of measured PostgREST bytes by origin:

| Day | Server (cron / edge functions) | Browser (your tabs) |
|---|---|---|
| 08-10 (today, partial) | 84.4 MB / 33,885 req | 4.1 MB / 1,808 req |
| 08-09 | 10.0 MB / 16,591 req | 13.5 MB / 1,359 req |
| 08-08 | 15.9 MB / 23,533 req | 9.7 MB / 726 req |

So ~95% of today's 88 MB comes from scheduled jobs reading PostgREST with the service key, not from opening Overview / Screener / Breakout.

Top offenders today (route, requests, bytes, KB per request):

| Route | Req | Bytes | KB/req |
|---|---|---|---|
| `srv:market-pipeline-aggregates market_stock_scores (76c)` | 4 | 14.1 MB | **3,443** |
| `srv:market_stocks` (unlabelled caller) | 2,318 | 14.0 MB | 6 |
| `srv:market-live-sweep market_stocks (1c)` | 447 | 10.0 MB | 22 |
| `srv:market-live-sweep market_stocks (5c)` | 866 | 8.4 MB | 9 |
| `srv:market-live-sweep market_stocks (4c)` | 456 | 8.0 MB | 17 |
| `srv:market-live-sweep rpc/market_live_settled_anchors_lean` | 228 | 3.8 MB | 16 |
| `srv:market-quotes market_api_settings (23c)` | 945 | 3.7 MB | 4 |
| `market_screener_rows (26c)` (browser) | 61 | 11.6 MB cycle | 190 |

Only one route breaks the 1 MB-per-fetch rule: the pipeline-aggregates score pull at ~3.4 MB per page.

## Fixes, in order of bytes saved

### 1. market-pipeline-aggregates — stop shipping the score table (~14 MB/day)
It pages `market_stock_scores` with 76 columns × ~2,900 rows just to compute breadth, sector strength, RS ranks and tracker candidates in JavaScript. Move those aggregations into a security-definer SQL function that returns the finished aggregates (a few KB), so the rows never cross the wire. The tracker pass keeps a narrow projection (symbol, exchange, close, score, a handful of level columns) restricted to candidate rows only.

### 2. market-live-sweep — one reference read per sweep, not per chunk (~26 MB/day)
The universe list and static meta are cached in isolate memory, but each 5-minute sweep runs as a chain of cold invocations, so the cache almost never hits. Replace the per-chunk reads with a single snapshot: the first invocation of a sweep builds the universe + static meta, stores it once (a compact JSON blob keyed by sweep/day), and every chained chunk reads that one small row instead of re-querying `market_stocks`. Same for `market_live_settled_anchors_lean` — resolve anchors once per sweep, not once per chunk.

### 3. Attribute and cache `srv:market_stocks` (~14 MB/day)
2,318 unlabelled reads/day means some callers still use a raw Supabase client instead of the metered/named wrapper. Route every edge function through the shared metered client so the caller shows up in the panel, then give symbol→metadata lookups a batched, day-cached accessor instead of per-symbol queries.

### 4. `market_api_settings` on every invocation (~7 MB/day)
Five functions re-read the settings row (22–23 columns) on each call. Add a shared cached accessor with a short TTL plus a narrow projection of only the fields each function uses.

### 5. Browser screener (190–206 KB per fetch)
Already under 1 MB, but two planes × two universes per visit adds up. Keep the board capped at the top 300 rows (already in place), and reuse the cached static plane across universe switches rather than refetching per universe key.

### 6. Enforce the rule automatically
- Client meter: flag and log any single response above 1 MB.
- Server meter: same ceiling, recorded with the function name.
- Extend `apply_egress_governor()` with a daily threshold so a bad day trips the low-bandwidth brake instead of waiting for the monthly budget.

## Verification
After the changes, re-check `system_egress_daily` for a full trading day: no route above 1 MB per request, server-side total under ~15 MB/day, and the screener/overview/breakout pages unchanged in what they display.

## Technical notes
Files: `supabase/functions/market-pipeline-aggregates/index.ts`, `market-live-sweep/index.ts`, `market-quotes/index.ts`, `_shared/market/serverEgress.ts` (+ a new settings/meta cache module), `src/lib/egressMeter.ts`, `src/lib/market/screenerRun.ts`.
Migrations: a new aggregate RPC for the pipeline, a small sweep-snapshot table, and the governor daily-threshold change — each with explicit GRANTs.