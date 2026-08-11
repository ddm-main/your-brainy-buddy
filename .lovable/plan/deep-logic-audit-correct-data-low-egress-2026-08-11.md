# Deep logic audit — correct data, low egress

Measured today (2026-08-11, 25.9 MB total, browser share ~0.4 MB). The remaining cost is structural, not incidental: **every optimisation so far caches in isolate memory, and the sweep runs as a chain of cold isolates, so almost no cache ever hits.**

## Verified facts behind this plan

| Signal | Value |
|---|---|
| Sweep runs recorded today | 68 |
| `market_sweep_snapshot` reads today | 244 (3.6 reads per run) |
| `market_api_settings` reads today | 242 (sweep, 907 KB) + 233 (autotrade-eval, 870 KB) |
| `market_daily_prices` reads in sweep today | 1,106 / 2.13 MB — the per-symbol close cache is not hitting |
| Aggregates (08-10) | 17,770 requests + 26 fat pages = 35 MB in one nightly pass |
| Unlabelled `srv:market_stocks` (08-10) | 2,318 requests / 14 MB — callers bypass the metered client |
| Snapshot rows stored | 1 (single chunk; the watched set is ~169 symbols) |

## The core logical flaw

`CHUNK = 200` and the watched universe is ~169 symbols, so a sweep needs exactly **one** pass — yet the snapshot is read 3.6x and settings 3.5x per run. Chaining, retries and preflight paths each spin a cold isolate that re-reads reference data before deciding it has nothing to do. Isolate caches (`systemFeedCache`, `closeCache`, `chunkMemo`) are structurally unable to help a cold chain.

## Improvements, ordered by bytes saved

### 1. Collapse the sweep to a single invocation (removes ~180 snapshot + ~180 settings reads/day)
- Skip the chain entirely when `watched <= CHUNK`: build, quote and write in one pass, no self-invoke.
- Build phase already has the snapshot in memory — never re-read it in the same request.
- Add an invocation-path label to `market_live_price_runs` (`build`/`chunk`/`retry`/`noop`) so the 3.6:1 ratio is attributable, then short-circuit the no-op paths *before* any reference read: market closed, empty watch set, sweep already in flight.

### 2. Reference data travels in the chain body, not through a re-read (when chaining is still needed)
When a chain is genuinely required (watched set grows past 200), pass the compact columnar chunk and the resolved settings fingerprint in the POST body of the self-invoke. A cold isolate then starts warm with zero PostgREST reads.

### 3. One settings accessor, split hot/cold columns (~1.8 MB/day)
`_shared/market/settingsCache.ts`:
- Hot projection (`id, active_provider, connection_status, base_url, token_expires_at, is_system, purpose`) — a few hundred bytes, 5-minute TTL, used for routing decisions.
- The `*_enc` blobs (session/view token, mpin, totp) are fetched **only** at the moment a broker request is actually signed, by id, never during routing.
Callers: `market-live-sweep`, `market-autotrade-eval`, `market-alerts-eval`, `market-quotes`, `market-orders`, `market-indices`, `market-funds`, `provider.ts:getSystemFeedRow`.

### 4. Fix the index-close cache that is not hitting (~2.1 MB/day)
1,106 `market_daily_prices` reads survive the per-symbol cache because each fallback runs in a fresh isolate. Resolve index closes **once when the snapshot is built** and carry them inside the snapshot payload, so `fromStoredClose` reads nothing during a sweep and only falls back outside the sweep path.

### 5. Aggregates: aggregate in SQL (~35 MB on aggregate days)
`market-pipeline-aggregates` still pages `market_stock_scores` (17,770 requests plus 76-column pages breaching the 1 MB ceiling). Replace the breadth / sector-strength / RS-rank passes with a security-definer RPC returning finished rows; the tracker pass keeps a narrow projection over candidate rows only. Identical output, a few KB.

### 6. Attribute and narrow every `market_stocks` reader (~14 MB/day)
2,318 unlabelled reads mean some functions still create a raw client. Make `svcClient()` the only construction path, add the route label, and switch `market-pipeline-eod`, `market-quotes`, `market-close-snapshot`, `market-history-backfill`, `market-nse-master-sync` to `market_universe` with explicit column lists so penny rows never cross the wire.

### 7. Make idle crons truly free
`market-alerts-eval`, `market-autotrade-eval`, `market-autotrade-fills` run every minute 3-10 UTC on weekdays (~480 runs each). The existence probe must be the literal first statement — before provider resolution, before feed routing, before heartbeat writes — and a negative probe must return without writing a heartbeat row.

### 8. Storage archive drain
`market-archive-prices` issues 2,052 storage GETs/day for 0.8 MB. Keep a per-day manifest object listing which symbol files exist, read the manifest once, and stop probing for objects that are known-absent.

### 9. Correctness guards kept intact
Every change above keeps the same predicates and the same rows — only column lists, round trips and cache placement change. Verification after one full session: `system_egress_daily` shows no `!OVER` rows, sweep snapshot under 1 MB/day, settings under 100 KB/day, and Overview / Screener / Breakout / Holdings display byte-identical values to today.

## Expected result

Idle logged-in trading day: **25.9 MB → ~2.5 MB**. Aggregate night: 35 MB → under 1 MB. No response above ~15 KB outside the nightly pass.

## Technical notes

- Files: `market-live-sweep/index.ts`, `_shared/market/sweepSnapshot.ts`, `_shared/market/indexQuotes.ts`, new `_shared/market/settingsCache.ts`, `_shared/market/provider.ts`, `_shared/market/common.ts`, `market-pipeline-aggregates`, `market-pipeline-eod`, `market-quotes`, `market-orders`, `market-indices`, `market-alerts-eval`, `market-autotrade-eval`, `market-autotrade-fills`, `market-close-snapshot`, `market-history-backfill`, `market-archive-prices`.
- Migrations: aggregates RPC with `GRANT EXECUTE`; `invocation_path` column on `market_live_price_runs`.
- Suggested order: 1 → 3 → 4 (biggest daily win, low risk), then 5 → 6, then 7 → 8.
