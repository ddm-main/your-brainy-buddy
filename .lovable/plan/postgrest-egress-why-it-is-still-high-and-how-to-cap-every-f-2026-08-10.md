# PostgREST egress: why it is still high, and how to cap every fetch

## What the measurements say (checked just now)

Your browsing is genuinely not the cause. Split of measured PostgREST bytes:

| Day | Server (cron / edge functions) | Browser (your tabs) |
|---|---|---|
| 08-10 (partial day) | 82.2 MB / 34,631 req | 3.9 MB / 1,879 req |
| 08-09 | 9.6 MB / 16,591 req | 12.9 MB / 1,359 req |
| 08-08 | 15.2 MB / 23,533 req | 9.3 MB / 726 req |

Opening Overview / Screener / Breakout 3-4 times costs about 4 MB total today. The remaining ~95% is scheduled jobs reading PostgREST with the service key.

Today's offenders:

| Route | Req | MB | KB/req |
|---|---|---|---|
| `srv:market-pipeline-aggregates market_stock_scores (76c)` | 4 | 14.1 | **3,443** |
| `srv:market_stocks` (caller not labelled) | 2,318 | 14.0 | 6 |
| `srv:market-live-sweep market_stocks (1c)` | 467 | 10.4 | 22 |
| `srv:market-live-sweep market_stocks (5c)` | 904 | 8.7 | 9 |
| `srv:market-live-sweep market_stocks (4c)` | 476 | 8.3 | 17 |
| `srv:market-live-sweep rpc/…anchors_lean` | 238 | 3.9 | 16 |
| `srv:market-quotes market_api_settings (23c)` | 945 | 3.7 | 4 |
| browser `market_screener_rows (21c/26c)` | 30 | 1.7 | 52-68 |

Only one route still breaks 1 MB per response, and it is the pipeline aggregates score pull.

## Why the previous round did not land

The narrowing work exists in the repo but is not what ran today. The 250-row page cap for `market_stock_scores` is in the source, yet today's meter still records 4 requests at 3.4 MB each — the deployed function predates it. The live-sweep snapshot idea (read the universe once per sweep instead of once per chunk) was never implemented: the code still queries `market_stocks` on every chunk, and there are three separate projections doing it. So the fix pass is partly "finish it", partly "deploy it".

## Penny stocks are still being read

This is a real, unfixed leak. `market_stocks` has 2,838 active rows, **1,184 of them penny-excluded**. Only four functions filter on `penny_excluded`: live-sweep, scrips-sync, shares-outstanding-sync, fundamentals-sync. Everything else — pipeline-aggregates' metadata pass, quotes, EOD, close-snapshot, history-backfill, news-sync, index-constituents — reads the full active set, so **~42% of every universe read is rows you deleted from the product**.

Also: `market_stock_scores` still holds 182 rows for penny-excluded symbols. The screener view is clean (0 penny rows), so this is dead weight being paged by the aggregates job.

## The fix pass

### 1. One penny rule, applied everywhere (~40% off every universe read)
- Add a `market_universe` view: active, non-penny, tradable symbols with the columns the jobs actually read. Every function that reads `market_stocks` for "the universe" switches to it, so the rule cannot be forgotten again in a new job.
- Delete the 182 orphan penny rows from `market_stock_scores` and add the same exclusion to the scoring writers.

### 2. market-pipeline-aggregates (~14 MB/day)
- Deploy the 250-row paging that already exists, and move the breadth / sector-strength / RS-rank math into a security-definer SQL function that returns finished aggregates (a few KB) instead of shipping ~2,000 score rows to Deno.
- The tracker pass keeps a narrow projection restricted to candidate rows only.

### 3. market-live-sweep (~27 MB/day)
- Build the universe + static meta **once per sweep** and store it as one compact JSON row keyed by sweep id; every chained chunk reads that single small row instead of re-querying `market_stocks` three times.
- Resolve `market_live_settled_anchors_lean` once per sweep on the same snapshot.

### 4. Label and cache the unattributed reads (~14 MB/day)
- 2,318 `srv:market_stocks` reads/day carry no caller name, so some functions still bypass the metered client. Route every edge function through it, then give symbol→metadata lookups a day-cached batched accessor instead of per-symbol queries.

### 5. `market_api_settings` on every invocation (~7 MB/day)
- Five functions re-read the 22-23 column settings row per call. Add a shared cached accessor with a short TTL and a narrow projection of only the fields each caller uses.

### 6. Browser side (already under 1 MB, tighten anyway)
- Keep the 300-row board cap, and reuse the cached static plane across universe switches instead of refetching per universe key.
- Make the full-plane fallback in `planProjection` log loudly; any unmapped field id gets added to the map so the fallback stops firing in normal use.

### 7. Make the 1 MB rule enforce itself
- Client and server meters already tag oversized rows (`!OVER`); promote that to a visible warning in the quota panel and a `system_maintenance_log` entry.
- Extend `apply_egress_governor()` with a daily threshold so a bad day trips the low-bandwidth brake instead of waiting for the monthly budget.

## Verification
After a full trading day: no route above 1 MB per request, server-side PostgREST under ~15 MB/day, penny symbols absent from every universe read, and Overview / Screener / Breakout showing identical values.

## Technical notes
- Files: `supabase/functions/market-pipeline-aggregates/index.ts`, `market-live-sweep/index.ts`, `market-quotes/index.ts`, `market-close-snapshot/index.ts`, `market-pipeline-eod/index.ts`, `market-history-backfill/index.ts`, `market-news-sync/index.ts`, `market-index-constituents/index.ts`, `_shared/market/serverEgress.ts` plus a new settings/universe cache module; `src/lib/market/screenerRun.ts`, `src/components/config/DatabaseStoragePanel.tsx`.
- Migrations: `market_universe` view, the aggregates RPC, a sweep-snapshot table, and the governor daily threshold — each with explicit GRANTs.
- The two TypeScript errors reported from the earlier async build (`gmail_sync_runs`, `src/routes/finance/Statements.tsx`) do not correspond to anything in the current tree — neither the table reference nor the file exists. That build log is stale; nothing to fix there.
