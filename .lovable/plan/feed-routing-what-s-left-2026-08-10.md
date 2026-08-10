# Feed routing — what's left

Re-verified against the current source and the live database just now (2026-08-10).

## Already done — confirmed, no work needed

- **Candle heartbeats (item 1)**: `market-candles` imports `recordFeedHeartbeat` and stamps every return path (cache hit, quote branch, live, and the failure path) via `heartbeatIdentity()`, which sets both provider and `path`. The rows in the database are still from 2026-08-07 with `path = null`, i.e. old evidence written before the change — the deployed code has simply not served a candle request since. Needs a live exercise, not a code change.
- **Auto re-probe + breaker chip (item 3)**: `FeedRoutingPanel` retries `DOWN`, `FALLBACK` *and* `NOT CHECKED`, and already renders "breaker open · {route}" chips from `market_route_health` (one stale row exists, opened 2026-07-30, `open_until` long past).
- **Saves via edge function (item 4)**: `market-feed-routing` exists (admin check, delete+insert, `invalidateFeedRouteCache()`), and the panel's mutation calls `supabase.functions.invoke("market-feed-routing")`.
- **Fundamentals chain (item 5)**: `market-fundamentals` resolves `resolveFeedRoute(svc, "fundamentals", chainFor("fundamentals"))` and walks fmp → yahoo with a latency budget.
- **Drop Kotak candles (item 6)**: `kotakProvider.getOHLCV` is now a straight delegate to Yahoo with `reason = "no_broker_history"` — no token lookup, no health logging.
- **False-ok Shoonya probes (part of item 7)**: no `ok = true` Shoonya rows remain; the four present rows are `degraded` / `failed` / `not_configured`.

## Remaining work

### 1. One staleness rule (item 2)

`feedStatus.ts` still derives freshness twice — inline in `baseStatusForFeed` (heartbeat age vs `freshMins`, plus a separate `stale` from table freshness) and again in `chainHealthFor`. And a heartbeat whose `path` is `cache` or `quote` is forced to `DELAYED`, which is the same badge a genuinely stale feed gets — the operator can't tell "answered instantly from cache" from "nobody has answered in an hour".

- Add one exported helper: age in minutes vs the feed's effective fresh window (including the `sessionOnly && market closed` widening), returning `{ ageMin, fresh, window }`.
- Use it in `baseStatusForFeed` and `chainHealthFor` — no other freshness math in the file.
- Add a `CACHED` status (accent/neutral tone, counted as healthy in `tallyRows`) used when the heartbeat is fresh and in-chain but `path` is `cache` / `quote`. `DELAYED` goes back to meaning only "too old".
- Update `STATUS_TONE`, the tally counters and the legend chips in `FeedRoutingPanel` for the new state.

### 2. Seed explicit routing defaults (item 7)

`market_feed_prefs` has zero rows, so every route today is implied by the built-in chain. Migration seeds `scope='system'` rows matching `BASE_CHAIN`: `ltp` kotak/shoonya, `indices` yahoo/kotak, `depth` kotak/shoonya, `candles_1d` yahoo/nse, `candles_intraday` yahoo, `fundamentals` fmp/yahoo. Routing then reads as an explicit operator decision, and `orderChain` behaviour is unchanged.

No probe-row deletion is needed — that data is already clean.

### 3. Signed-in verification pass

Log in as the supplied account and drive `/config/feeds`:

- Load a chart (Analysis) so `market-candles` actually runs, then confirm `market_feed_heartbeat` shows fresh `candles_daily` / `candles_intraday` rows carrying `path` (`live` / `cache` / `quote`) and a real provider.
- Run "test everything" and check Kotak's ok-rate is realistic now that candles no longer touch it.
- Confirm the breaker chip renders and that a pinned primary changes the provider in the actual response payload, not just the chip.
- Fix whatever this pass turns up (the stale breaker row may want an "expired" treatment rather than a permanent chip).

## Technical notes

Files touched: `src/lib/market/feedStatus.ts`, `src/components/config/providers/FeedRoutingPanel.tsx`, one migration. Plus a new unit test in `tests/feedStatus.test.ts` for the staleness helper and the `CACHED` classification.
