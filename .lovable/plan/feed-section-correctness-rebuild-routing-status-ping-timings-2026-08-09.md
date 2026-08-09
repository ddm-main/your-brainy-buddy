# Feed section — correctness rebuild (routing, status, ping timings)

Verified against the live database and the actual code paths on 2026-08-09.

## What is already done (from the earlier feed/broker split)

- `market_api_settings.purpose` and `market_feed_prefs.scope='system'` exist; no per-user routing rows remain.
- `getReadProvider` no longer falls back to a user's personal broker session, and the data-feed panel lives in Admin Config.
- One status engine (`computeFeedRows`) drives both the navbar chip and the Feed Routing table; account feeds are tallied separately from platform feeds.
- Surface probes carry a `plane` (`data` vs `account`) and an `is_primary_path` flag; the client reads only the data plane for platform health.
- A stale probe decays to NOT CHECKED instead of showing yesterday's verdict.

## What is broken (confirmed, not assumed)

**1. Feed Routing selectors do nothing.** `getFieldOverrides` / `resolveField` / `buildChain` in the edge resolver are referenced by no other function in the project. The live serving routes (`market-quotes`, `market-candles`, `market-indices`, depth) choose their provider through `getReadProvider`, which never reads `market_feed_prefs`. Picking a Primary or Fallback changes the chip text and nothing else. The prefs table is currently empty, so nothing has been silently mis-routed yet.

**2. The routing map does not cover the feeds it is offered for.** `FEED_FIELDS` has no entry for `candles_1d`, `candles_intraday` or `depth`, and its `indices` entry maps onto the same `ltp` / `change` fields as the stock quote feed — pinning Indices would also re-route every stock price.

**3. Heartbeats record a code path, not a provider.** Stored rows are `indices → "mixed"`, `candles_intraday → "quote"`, `candles_daily → "cache"`. `sameProvider()` cannot match those names, so healthy feeds render FALLBACK — exactly what the page shows now ("Indices … served by mixed", "Intraday candles … served by quote"). Per-row 24h stats also vanish, because those names canonicalise to nothing.

**4. Kotak's health number is false.** In the last 24h `market_provider_health` holds 5,382 Kotak rows, 5,280 of them `getOHLCV — "no token for NSE:<sym> — using yahoo"` logged as failures with `latency_ms = 0`. Kotak publishes no candle API by design, so history backfill records a "failure" per symbol. The panel therefore prints "2% ok · 0ms p50" for the primary quote provider that is actually answering fine.

**5. Ping timings are inconsistent and partly stale.** The probe families ran at 17:37 (broker/NSE/BSE), 17:40 (FMP/Alpha) and 17:43 (Yahoo); the panel shows one global "checked" age that hides this. Every Shoonya data-plane probe is from 2026-08-08 and is silently dropped by the 24h cutoff, so Shoonya reads as absent rather than unchecked.

**6. Failing fallbacks are invisible.** NSE's `candles_1d` probe is failing ("quote-equity returned nothing for RELIANCE"), but because Yahoo answers, the row is green and the broken fallback stays hidden until Yahoo also fails.

**7. Auto-retry is over-eager.** The background retry loop fires for DELAYED rows too, so a cache that is stale by design (daily candles, 2 days old outside the session) triggers repeated `market-test-connection` probes.

## Plan

### A. Make routing real
1. Add a shared `resolveFeedRoute(svc, feedId)` helper that reads `scope='system'` prefs and returns `primary → fallback → built-in chain`, with the existing TTL cache and an invalidation hook.
2. Consume it in the live routes: `market-quotes` (ltp), `market-indices`, `market-candles` (daily + intraday) and `market-depth`, so a pin genuinely reorders providers and a pinned-but-down provider degrades down the chain instead of going dark.
3. Split the `indices` routing key off the stock `ltp` fields; add `candles_1d`, `candles_intraday` and `depth` entries. Any feed with no honoured route is marked `routable: false` in the catalog rather than showing a selector that does nothing.
4. Invalidate the pref cache when the panel saves.

### B. Truthful heartbeats
5. Stamp heartbeats with the canonical provider that actually served (`kotak_neo`, `yahoo`, `nse`, `shoonya`) and move `cache` / `quote` / `mixed` into a separate path field.
6. For multi-provider batches record the dominant provider plus the mix in the detail, so "Indices — Yahoo 4/5, Kotak 1/5" reads LIVE, not FALLBACK.
7. Teach `sameProvider()` and `providerLabelFromProbe()` about the path values so existing rows degrade gracefully instead of turning red.

### C. Honest provider health and ping timings
8. Stop logging Kotak `getOHLCV` "no token → yahoo" as a provider failure; record it as a routed fallback (or skip it) so the success rate reflects real Kotak calls.
9. Fix the 24h stats: aggregate server-side per provider instead of pulling an unordered 2,000-row sample, exclude zero/null latencies from the p50, and take attempts from the same window as the rate.
10. Show each feed's own probe age on its row and replace the single global "checked" age with per-family timestamps.
11. Probe all providers in one self-test pass so timings share a run; keep keyed vendors (FMP, Alpha) on their slower cadence but label them "last checked" rather than letting them look stale.
12. Surface Shoonya as NOT CHECKED with its age instead of dropping it at the 24h cutoff.

### D. Chain visibility and auto-switching
13. Render a per-provider health strip on each feed row (one chip per provider in the chain, coloured by its own latest probe), so a failing fallback such as NSE `candles_1d` is visible while the feed is still green.
14. Restrict auto-retry to FALLBACK and DOWN rows, skip on-demand and cache-backed feeds, keep the 30s → 2m → 10m backoff.
15. Add an explicit "auto-switched" marker when the serving provider differs from the configured primary, with the reason taken from the primary's probe.

### E. Verification
- Sign in with the supplied account, open `/config/feeds`, and confirm: Indices and Intraday candles read LIVE, Kotak's health line shows a realistic success rate, every row shows its own probe age, and a pinned primary changes which provider actually answers (checked in the response payload and edge logs, not just the chip).
- Run the existing vitest suite plus new tests for heartbeat provider canonicalisation, `resolveFeedRoute` chain building, and the health-stat aggregation.
- Re-run "test everything" and re-read the probe rows to confirm one coherent run timestamp.