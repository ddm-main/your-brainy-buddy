# Feed routing — make it real, fast, and honest

Verified against the current source: `getReadProvider` takes a feed id in only four call sites (`market-quotes` ltp, `market-indices` indices, `market-candles` daily/intraday); `market-depth`, `market-alerts-eval`, `market-backtest-run` and `market-morning-insight` call it with no feed id. `orderChain` / `resolveFeedRoute` in `feedRoute.ts` have no callers — `getReadProvider` reimplements a narrower chain inline. `resolver.ts` imports `getReadProvider` but nothing imports `resolver.ts`.

Goal: one routing engine, one staleness rule, one meaning per component. Nothing in the order/trading path changes.

## A. One routing engine

1. Delete `_shared/market/resolver.ts` (`PRIORITY_CHAINS`, `FEED_FIELDS`, `resolveField`) — dead code with no importers. `feedRoute.ts` becomes the single source of truth.
2. Rewrite the chain logic inside `getReadProvider` to call `orderChain(base, route)` and walk primary → fallback → built-in chain generically, so any pin (including `shoonya`) is honoured. `toProviderName` is the only id translation.
3. Give every caller a feed id: `market-depth` → `depth`, `market-alerts-eval` → `ltp`, `market-backtest-run` → `candles_1d`, `market-morning-insight` → `ltp`.
4. `getReadProvider` returns the resolved route, so the duplicated `vendorPinned` / `skipBroker` checks in `market-quotes` and `market-indices` are removed.
5. Fundamentals: implement the `fmp → yahoo` chain in `market-fundamentals` (FMP is currently failing) for fundamentals, company_info, shares and ownership.

## B. Remove the waste and the hangs

6. Drop `getOHLCV` from the Kotak provider surface — Kotak publishes no candle API, so candles go straight to Yahoo/NSE and ~1980 doomed calls/day disappear (and Kotak's ok-rate stops being dragged to single digits).
7. Per-call latency budget with `AbortController`: quotes 1.2 s, candles 3 s, funds 4 s. A timeout counts as a failure and advances the chain — this is what turns "slow feed" into "fast fallback".
8. Skip probing any provider whose session is `not_configured` or `expired` (today's Shoonya funds/holdings/positions probes).

## C. Honest status

9. Probe writer treats `ltp = 0` or null as `failed`; migration purges the two false-ok Shoonya rows.
10. Stamp a heartbeat on every candle response path (including cache hits, with the path recorded), so chart status is never judged on days-old evidence.
11. Extend `market_provider_stats_24h` to group by `(provider, endpoint)` and show each feed its own number instead of the provider-wide sum.
12. One shared staleness helper used by both `baseStatusForFeed` and `chainHealthFor`. `path !== "live"` no longer forces `DELAYED`; "served from cache" becomes its own state.
13. Auto re-probe includes `NOT CHECKED` rows (not just `DOWN`/`FALLBACK`), and `market_route_health` breaker state is surfaced as a chip.
14. New `market-feed-routing` edge function: the panel saves through it instead of writing the table from the browser, and it calls `invalidateFeedRouteCache()`. `getFeedRoutes` logs read failures instead of silently returning `{}`.

## D. Migration

15. Consolidate the 5 overlapping `market_feed_prefs` policies to one read + one admin-write; seed the intended defaults as real `scope='system'` rows so routing is explicit; delete the false-ok Shoonya probe rows.

## Technical notes

Touched: `_shared/market/provider.ts`, `feedRoute.ts`, `resolver.ts` (deleted), `selftest.ts`, `heartbeat.ts`, `market-depth`, `market-quotes`, `market-indices`, `market-candles`, `market-fundamentals`, `market-alerts-eval`, `market-backtest-run`, `market-morning-insight`, new `market-feed-routing`; frontend `lib/market/feedStatus.ts`, `lib/market/selftest.ts`, `FeedRoutingPanel.tsx`, `feedCatalog.ts`; one migration.

Verification: unit tests for `orderChain` pin ordering, the latency-budget fallback, zero-ltp probe classification and the shared staleness helper; then re-run "test everything" and confirm on `/config/feeds` that Kotak shows a realistic ok-rate, candle rows carry fresh heartbeats, and a pinned primary changes which provider actually answers (checked in the response payload, not just the chip).
