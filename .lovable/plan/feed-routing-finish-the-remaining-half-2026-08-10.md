# Feed routing — finish the remaining half

Re-verified against the current source and the live database today.

## Already done (no work needed)

- `resolver.ts` is deleted; `feedRoute.ts` is the only routing module.
- `getReadProvider` now walks `chainFor(feedId)` through `orderChain(base, route)` and returns `{ route, chain, resolved }`; `market-quotes` and `market-indices` consume that instead of their own pin checks.
- Every caller passes a feed id: depth → `depth`, alerts-eval → `ltp`, backtest-run → `candles_1d`, morning-insight → `ltp`, candles → `candles_1d` / `candles_intraday`.
- Latency budgets are applied on quotes and depth.
- Probes classify `ltp = 0` as a failure; unconfigured/expired sessions are skipped in the self-test.
- `market_provider_surface_stats_24h` exists (per provider *and* endpoint).
- `market_feed_prefs` is down to 2 policies.

## Remaining work

### 1. Candle heartbeats are dead evidence
The heartbeat rows for `candles_daily` and `candles_intraday` are from 2026-08-07 and carry no `path`, while quotes/indices are minutes old. The candle paths that return early (cache hits, guard short-circuits, the intraday snapshot branch) don't stamp anything. Stamp a heartbeat on every return path in `market-candles` with `path` set to `live` / `cache` / `quote`, including the served provider.

### 2. One staleness rule
`feedStatus.ts` re-derives freshness in `baseStatusForFeed` and in the chain-health path, and `path !== "live"` still collapses to DELAYED. Extract a single helper (age vs the feed's fresh window) used by both, and give "served from cache" its own state instead of borrowing DELAYED.

### 3. Auto re-probe and breaker visibility
The retry loop only fires for `DOWN` and `FALLBACK`. Include `NOT CHECKED` rows so a never-probed feed self-heals. Surface `market_route_health` breaker state as a chip on the affected row (one open breaker row exists today).

### 4. Saves go through an edge function
`FeedRoutingPanel` writes `market_feed_prefs` straight from the browser, so the 30s edge-side route cache keeps serving the old pin. Add `market-feed-routing` (admin-checked read/write) and have the panel call it; the function calls `invalidateFeedRouteCache()` after each write.

### 5. Fundamentals chain
`market-fundamentals` calls Yahoo only — the `fmp → yahoo` chain is not implemented for fundamentals, company_info, shares and ownership. Route it through `resolveFeedRoute` with a `funds`-style latency budget, falling through to Yahoo when FMP fails (it is failing today).

### 6. Drop Kotak candles
Kotak's `getOHLCV` still exists and logs a provider-health failure per tokenless symbol before delegating to Yahoo, which is what drags Kotak's ok-rate into single digits. Remove candle support from the Kotak surface so candles go straight to Yahoo/NSE and those calls stop being logged as Kotak failures.

### 7. Migration
- Delete the 2 false-ok Shoonya probe rows.
- Seed the intended defaults as real `scope='system'` rows (`market_feed_prefs` has none), so routing is explicit rather than implied by the built-in chain.

## Technical notes

Touched: `_shared/market/provider.ts`, `heartbeat.ts`, `market-candles`, `market-fundamentals`, new `market-feed-routing`; frontend `lib/market/feedStatus.ts`, `FeedRoutingPanel.tsx`; one migration.

Verification: unit tests for the shared staleness helper and the fundamentals chain ordering, then a signed-in browser pass on `/config/feeds` — run "test everything" and confirm candle rows carry fresh heartbeats, Kotak shows a realistic ok-rate, the breaker chip renders, and a pinned primary changes the provider in the actual response payload, not just the chip.
