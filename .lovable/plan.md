
# Market Config — feed & provider audit

Everything below was verified against the live database and the current code, not inferred.

## What is actually broken

### 1. Kotak is called for indices on every poll, always fails, and is charged for it
`kotakProvider.getQuotes` still routes any tokened index through `resolveKotakIndexQuote`, even though the capability matrix already declares Kotak incapable of `index_quotes`. Evidence from the last 24h of `market_provider_health`:

- `getQuotes:index` — **1,048 rows, 100% failed**, avg latency **2,913 ms**, error `missing index rows: NSE:^NSEI,NSE:^NSEBANK,NSE:^INDIAVIX`
- `getQuotes` — **539 failures** with `no quote rows for BSE:^BSESN` (Sensex, same cause)

Consequences, all real: the index poll waits ~3 s on a call that can never succeed before the NSE/BSE/Yahoo chain even starts; Kotak's 24h success rate on the Providers page reads ~40% when its equity quote path is healthy; and these rows are the single largest writer into a database already at 430 MB of the 500 MB limit.

Fix: never send an index key to Kotak. Filter index requests out at the top of `kotakProvider.getQuotes` (using `isIndexSymbol` + the BSE alias list) and hand them straight to `resolveIndexQuotes`. Drop `resolveKotakIndexQuote` and its health logging. The index chain becomes NSE/BSE native → Yahoo → stored close, which is what already serves every displayed index today.

### 2. Provider health is polluted, so every stat and sparkline on the Providers page is wrong
- Failures are logged unsampled while successes are sampled at 5%, so the table over-represents failures by 20x — the "24h success rate" is not a success rate at all.
- `market-pipeline-eod` writes one `kotak_neo` health row **per symbol** for `insufficient candles` / `yahoo chart …404` (617 rows/24h). These are data-coverage problems for symbols that Kotak never served; attributing them to the broker is simply wrong.

Fix: sample failures at the same rate as successes for high-frequency endpoints (keep 100% for the low-frequency `market-test-connection` probe), stop pipeline-EOD symbol errors from writing provider health at all (they belong in the pipeline's own error summary), and compute the Providers 24h rate from `endpoint = 'market-test-connection'` plus the live quote endpoints only.

### 3. "Which provider is fastest for this feed" cannot be answered today
`recordSurfaceProbes` stamps the **whole run's** latency onto every surface of a provider, so Kotak's `quotes`, `depth`, `funds`, `holdings`, `positions` all carry the same number (and service providers carry the reachability-probe latency). The current rows show `latency_ms: null` for the broker/Yahoo probes entirely.

Fix: time each surface probe individually inside `surfaceReport` and store that per-row. Then the Feed Routing panel can show, per feed, each candidate provider's measured latency and mark the fastest healthy one — which is the routing evidence you asked for.

### 4. Surfaces that report a state they did not earn
- **NSE `bhavcopy` and `candles_1d`** are hard-coded to "ok" from the generic reachability check (`out["bhavcopy"] = { ok: true, ... }`). Only `constituents` and `corp_actions` run a real assertion — and `constituents` is currently **failing** ("NSE returned no Nifty 50 constituents") while sitting on the primary path.
- **`funds` / kotak_neo** is degraded on `available margin not reported (used=0)` — correct classification, but it has been degraded continuously, so the Kotak limits call needs its own look rather than a permanent amber.
- **Shoonya** probes run and fail with "authorization is required" (29 rows/24h). An unauthorized broker is *not configured*, not *failed*.

Fix: give bhavcopy a real assertion (latest bhavcopy date vs last trading day) and candles_1d a real NSE history call; add a `not_configured` state that Shoonya (and any keyless provider without credentials) resolves to, excluded from the down/degraded tallies; investigate the Kotak limits payload and, if the field genuinely isn't published on this account type, report funds as "partial — margin not published" instead of degraded-forever.

### 5. Feed Routing labels vs. probe providers
The panel compares heartbeat/probe provider strings against catalog chain ids (`kotak`, `yahoo`, `nse`, `fmp`, `alpha`) while the writers store canonical ids (`kotak_neo`, `alpha_vantage`). That mismatch is what produces "Kotak Neo did not answer — served by Yahoo Finance" on feeds whose Kotak probe is green.

Fix: canonicalise both sides through the existing `canonicalProviderId` before comparing, in the catalog chains as well as in the panel's `sameProvider` / `providerLabelFromProbe`.

## Feed-by-feed routing after the fixes

| Feed | Primary | Fallbacks | Why |
|---|---|---|---|
| Equity quotes / LTP | Kotak Neo | Yahoo (off-session only) | Broker tick is realtime; Yahoo is ~15 min delayed and must never substitute intraday |
| Index quotes | NSE allIndices (NSE), BSE feed (Sensex) | Yahoo → stored close | Exchange-native and undelayed; Kotak removed entirely |
| Market depth | Kotak Neo | none | Only source of a 5-level ladder; idle off-session |
| Daily candles | Yahoo | NSE bhavcopy → cache | Kotak publishes no candle API |
| Intraday candles | Yahoo | quote-built bars | same |
| Funds / holdings / positions / orders | Kotak Neo | none | Account data has one source |
| Bhavcopy / constituents / corp actions | NSE | BSE for corp actions | Exchange of record |
| Fundamentals / company info / shares | FMP | — | Only keyed source |
| Indicators | Alpha Vantage | local computation from daily candles | Alpha is rate-limited and currently failing its probe |

## Improvements beyond the bug fixes

1. Per-feed latency and success columns in Feed Routing, with a "fastest healthy provider" marker and a one-click "route this feed to X" that writes the per-user override already supported.
2. A `not_configured` chip so providers with no credentials stop looking like outages.
3. Local RSI/indicator computation from `market_daily_prices` as the Alpha Vantage fallback — removes a rate-limited external dependency from the score pipeline.
4. Retention on `market_provider_health` tightened to 3 days for high-frequency endpoints (7 days kept for the self-test probe), plus the write reductions above — meaningful relief on the 430 MB / 500 MB database.
5. Probe rows keyed by `(surface, provider)` with a canonical-id check so no legacy spelling can be resurrected.

## Technical notes

Files to change: `supabase/functions/_shared/market/provider.ts` (index short-circuit, health sampling, remove `resolveKotakIndexQuote`), `supabase/functions/_shared/market/selftest.ts` (per-surface latency, real NSE assertions, `not_configured` state, Shoonya gating), `supabase/functions/_shared/market/heartbeat.ts` (unchanged unless latency needed), `src/lib/market/selftest.ts` (state handling, stats source filter), `src/components/config/providers/feedCatalog.ts` + `FeedRoutingPanel.tsx` + `ProviderDetail.tsx` (canonical ids, latency columns, not-configured chip), `supabase/functions/market-pipeline-eod` (stop writing per-symbol provider health), plus one migration for the `market_surface_probes` state enum widening and the health-retention job.

No order-placement, credential, or trading-logic paths are touched.
