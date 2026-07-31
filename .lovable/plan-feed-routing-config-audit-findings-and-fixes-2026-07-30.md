# Feed Routing & Config audit — findings and fixes

## What the status actually says right now (verified against the database)

Current probe rows in `market_surface_probes`:

- `index_quotes` / kotak_neo — **failed**, "no index rows", marked as the primary path
- `index_quotes` / yahoo — ok, "Nifty 50 ltp=24317.15", marked as *not* primary
- `depth` / kotak_neo — degraded today ("no bid/ask levels"), **plus a stale `kotak` row from 2026-07-29 that still says ok**
- `quotes` — kotak_neo ok today, plus the same stale duplicate `kotak` row
- everything else (candles, bhavcopy, constituents, corp actions, fundamentals, indicators, funds, holdings, positions) — ok

So the tally is not honest yet. Three concrete defects produce the "17 live / 1 fallback / 3 idle" and the red chip.

## 1. Why the header shows IDX DOWN

Kotak Neo is declared capable of `index_quotes` in the server capability matrix and is set as its primary route, but the Kotak quote call for `NSE:^NSEI` returns nothing — it has no index instrument coverage. Indices are in fact being served fine (the `indices` heartbeat shows `mixed`/Yahoo, ok, seconds old).

`FeedStatusChip` turns red purely because a probe with `is_primary_path = true` failed, ignoring that a healthy provider answered the same surface. The result: a permanently red "IDX DOWN" for a feed that works.

Fix:

- Drop `index_quotes` from `kotak_neo` in `PROVIDER_SURFACES` (same treatment candles already get), so the dead combination is never probed or stored.
- Set `PRIMARY_BY_SURFACE.index_quotes = "yahoo"` and reorder the `indices` chain in the feed catalog to `["yahoo", "kotak"]`.
- Change the chip so red means *no provider serves the surface*; a working fallback renders amber, not red. Remove the special-case `IDX DOWN` label and show the standard `ok/total` with a tooltip naming the degraded feed.

## 2. Stale duplicate provider rows poison the tally

Probes are stored with `onConflict: (surface, provider)`, and older runs wrote the provider as `kotak` while current runs write `kotak_neo`. The 2026-07-29 `kotak` rows are therefore never overwritten and never expire. `bestBySurface` picks the *healthiest* row, so yesterday's "depth ok" beats today's "depth degraded" — Market depth renders LIVE off-session on day-old evidence.

Fix:

- Delete the legacy non-canonical rows in a migration and add a canonical-id check so only canonical provider ids can be written.
- Ignore probe rows older than a cutoff (24h) when computing status, so a surface that stops being probed decays to IDLE instead of holding a stale LIVE.

## 3. Rows that report the wrong state

- **Market depth** — off-session an empty ladder is expected; with the stale row gone it must read IDLE (it is already `sessionOnly`), not LIVE and not DOWN.
- **Funds** — the probe reports ok on `available=null used=0`. A null available margin is not a healthy funds feed; classify it as degraded with the reason shown.
- **Orders read / Orders write** — IDLE is correct and stays.
- After fixes 1–3 the group counters are recomputed from the same corrected rows, so header chip, Providers and Feed Routing agree.

## 4. Provider health history is invisible to the app

`market_provider_health` holds thousands of rows (kotak_neo 5,495; yahoo 578; fmp/alpha/nse/bse all populated), but it has **only a service-role policy** — no SELECT for `authenticated`. Every client read returns an empty array, which is why the 24h success rate, median latency and the health sparklines are blank on every provider row.

Fix: add a read-only policy plus the matching grant for `authenticated` on `market_provider_health` (status data only, no credentials in the table).

## 5. Provider coverage gaps

- **Shoonya** is in the catalog and in the capability matrix but `runSelfTest` only probes Kotak, Yahoo and the keyless services — Shoonya feeds can never show status. Add it to the self-test run, skipped cleanly when no Shoonya session exists.
- **Kotak Neo** catalog entry still lists daily/intraday candles as its own feeds while the routing chain (correctly) excludes it. Mark those two as unsupported-by-provider so the provider page stops implying Kotak serves charts.
- **FMP / Alpha Vantage / NSE / BSE** are only ever probed as "is the key/endpoint reachable" and that single result is fanned out to several surfaces. Each surface will get its own lightweight assertion (profile, ratios, bhavcopy date, constituents count, corp-action count) so a partially broken vendor is not reported as fully healthy.
- Every table referenced by the catalog exists, so the freshness reads are sound; no change needed there.

## 6. Rest of the Config section

- Feed Routing: the "auto-probing primary in background…" pill can show while no retry is pending; tie it strictly to the last retry timestamp.
- Feed Routing: manual overrides are per-user, but the panel does not say which rows are overridden by *you* versus defaults beyond a summary line — add a per-row marker and a one-click reset.
- Database & Quota: the project is at ~407 MB of the 500 MB Postgres limit with `market_daily_prices` alone at 243 MB. Surface a clear warning band and a retention hint in the panel (no data deleted without your approval).
- Providers list: rows for providers with no credentials and no probe currently look identical to healthy ones until expanded; give them an explicit "not configured" chip.

## Technical notes

Files touched: `supabase/functions/_shared/market/selftest.ts` (capability matrix, primary map, per-surface service assertions, funds classification, Shoonya run), `src/components/config/providers/feedCatalog.ts` (indices chain, Kotak candle feeds), `src/components/hud/FeedStatusChip.tsx` (red/amber logic), `src/lib/market/selftest.ts` (24h probe cutoff, canonical ids), `src/components/config/providers/FeedRoutingPanel.tsx` (retry pill, override markers), plus one migration for the `market_provider_health` read policy and the legacy probe-row cleanup.

No trading behaviour, order paths or credentials are modified.
