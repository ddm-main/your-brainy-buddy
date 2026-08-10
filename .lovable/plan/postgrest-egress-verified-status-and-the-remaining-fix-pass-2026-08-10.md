# PostgREST egress — verified status and the remaining fix pass

## What I checked against the live project

| Item from your plan | Actual state |
|---|---|
| `market_universe` view | **Exists in the database already** — active + non-penny, 22 columns. But **zero edge functions use it**; a repo-wide search finds it only in the generated types file. The view is built, unwired. |
| Penny filter coverage | Confirmed: only `market-live-sweep`, `market-scrips-sync`, `market-shares-outstanding-sync`, `market-fundamentals-sync`, `market-archive-prices`, `market-penny-sweep` filter `penny_excluded`. Aggregates' metadata pass, quotes, EOD, close-snapshot, history-backfill, news-sync, index-constituents do not. |
| Penny share of the universe | 2,832 active symbols, **1,011 penny-excluded (36%)**, and **182 orphan penny rows still in `market_stock_scores`**. |
| Aggregates 250-row cap | In source (`SCORE_PAGE = 250`). Today's meter shows **4 requests × 3.4 MB** for the 76-column score pull — 4 pages means 1,000-row paging, i.e. the **deployed build predates the cap**. |
| Live-sweep "read universe once per sweep" | **Not implemented.** Still one keyset read of `market_stocks` per chunk (4 cols, penny-filtered). |
| Live-sweep's other two universe reads | They are **not** in live-sweep — they come from `_shared/market/provider.ts` (`symbol,exchange,token,kotak_segment,instrument_type` for Kotak, `symbol,exchange,shoonya_token` for Shoonya), called per quote chunk. That is the 8.7 MB + 10.4 MB. |
| `anchors_lean` | Already lean (symbol + prev_close), but still called **once per chunk** — 238 calls, 3.9 MB. |
| Caller labelling | `setEgressCaller` **is** wired, in `_shared/cors.ts` `preflight()`. The 2,318 unlabelled `srv:market_stocks` reads are functions/paths that never call `preflight()` — mainly the shared provider token lookups running inside chained invocations. |
| `apply_egress_governor` daily threshold | **Already done** — 20 MB/day cap with `daily_brake`. Nothing to build. |
| Browser side | Already done: 300-row board cap, server-side universe narrowing, `planProjection`. Browser cost today is 3.9 MB across 1,879 requests. |

So: three of your items are already complete (governor, browser narrowing, the universe view's SQL), one is written but undeployed (aggregates paging), and the rest is real remaining work.

## The remaining work

### 1. Wire the universe view everywhere (~36% off every universe read)
Switch the "give me the tradable universe" reads in `market-pipeline-aggregates`, `market-quotes`, `market-pipeline-eod`, `market-close-snapshot`, `market-history-backfill`, `market-news-sync`, `market-index-constituents` from `market_stocks` to `market_universe`. Delete the 182 orphan penny rows from `market_stock_scores` and add the exclusion to the scoring writers so they cannot come back.

### 2. Sweep snapshot — build the universe once per sweep (~27 MB/day)
New `market_sweep_snapshot` table keyed by sweep id, holding one compact JSON blob: the page list, static meta (`yahoo_symbol, series, total_shares_cr`), broker/Shoonya tokens, and the settled anchors. The first invocation of a sweep writes it; every chained chunk reads that single small row. This removes the per-chunk `market_stocks` read, both per-chunk provider token lookups, and the per-chunk `anchors_lean` call.

### 3. Aggregates — deploy the cap, then move the math into SQL (~14 MB/day)
Redeploy so the existing 250-row paging takes effect, then replace the score-row download with a security-definer RPC that returns finished breadth / sector-strength / RS-rank aggregates (a few KB) instead of ~2,000 rows of 76 columns. The tracker pass keeps a narrow projection over candidate rows only. Fundamentals and breakout-tracker passes drop from 1,000-row to 250-row pages.

### 4. Label the unattributed reads (~14 MB/day)
Have the provider token helpers set an egress caller tag of their own, and give symbol→token/metadata lookups a day-cached batched accessor in module scope instead of a query per quote chunk.

### 5. `market_api_settings` accessor (~7 MB/day)
One shared cached accessor in `_shared/market/` with a short TTL and a narrow column list per caller; `market-quotes` (951 reads/day), `market-live-sweep`, `market-autotrade-eval`, `market-orders`, `market-indices` all switch to it.

### 6. Make the ceiling visible
The meters already tag `!OVER` / `!1MB`. Surface those rows as a warning in the quota panel and write a `system_maintenance_log` entry when one appears, so the next regression is noticed the same day rather than a week later.

## About signing in and testing

Every route in this fix pass is server-side cron and edge-function traffic — none of it is reachable by clicking through the app while signed in. After the changes I will verify by: re-reading `system_egress_daily` for the next full trading day (no route above 1 MB per request, server PostgREST under ~15 MB/day), querying that no penny symbol appears in any universe read path, and loading Overview / Screener / Breakout in the signed-in preview to confirm the displayed values are byte-identical to today's.

Also confirmed from your notes: the two TypeScript errors (`gmail_sync_runs`, `src/routes/finance/Statements.tsx`) reference nothing in the current tree — that build log is stale.

## Technical notes
- Functions touched: `market-pipeline-aggregates`, `market-live-sweep`, `market-quotes`, `market-close-snapshot`, `market-pipeline-eod`, `market-history-backfill`, `market-news-sync`, `market-index-constituents`, `_shared/market/provider.ts`, plus a new `_shared/market/settingsCache.ts` and `sweepSnapshot.ts`.
- Migrations: `market_sweep_snapshot` table (with GRANTs), the aggregates RPC (with `GRANT EXECUTE`), and a data cleanup of the 182 orphan score rows. No change to `market_universe` or `apply_egress_governor` — both already correct.
- No displayed value changes anywhere: same predicates, same rows, fewer columns and fewer round trips.
