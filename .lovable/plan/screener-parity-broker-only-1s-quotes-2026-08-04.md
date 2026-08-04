# Screener parity + broker-only 1s quotes

## Part A — status of your plan (verified in code)

Already implemented:

- **Live/EOD mode** exists. `screenerCatalog.ts` has `LIVE_FILTER_IDS` + `filterMatchesLive`, `screenerLive.ts` batch-quotes candidates, and `Screener.tsx` runs a two-pass filter (`eodFiltered` → live pass) with a `Filters · live / Filters · EOD` toggle.
- **Display/filter agreement**: the LTP and 1D-Return cells only overlay a live value when `liveMode` is on or the quote's own `provider === "kotak"` (`Screener.tsx` ~756–771); otherwise EOD values render. Per-quote `provider` is already attached.
- **Reconnect chip**: `liveState` no longer emits "delayed · yahoo"; when Kotak is disconnected the chip becomes a clickable "reconnect" affordance opening `KotakReconnectModal`.
- **Exact-session gate**: `EXACT_SESSION_FILTERS` = ltp, change_pct, volume, vol_gt_avg30, rel_volume — these still require `trade_date === latest` even though the general tech tolerance is 3 days. `latestTradeDateOf` has the `settledOnly` rule so an intraday partial can't become the reference session.

Still open:

1. `useScreenerLiveQuotes` polls at 15 s, and sorting for the live columns is not re-derived per mode in every path.
2. Backend does not distinguish "Kotak auth expired" from "generic failure" — a Kotak miss silently becomes a Yahoo row, so the client can't state *why* it degraded.
3. Auto-open vs click-only reconnect modal — see the question below.

## Part B — broker-only, 1-second quotes (the new priority)

**Rule: every live price comes from Kotak Neo, refreshed each second, and is never written to the database.**

1. **Broker-only quote mode**
   - New setting `quotes.broker_only` (default ON): `market-quotes` resolves through Kotak Neo only. If Kotak has no session or the symbol fails, the response returns the row with `provider: "kotak"` omitted and an explicit `reason` (`session_expired`, `not_covered`, `rate_limited`) — never a silent Yahoo substitute.
   - Yahoo stays available only as an explicitly labelled fallback for symbols Kotak does not cover, and such values are never used by live filters.

2. **1-second cadence without melting the rate limit**
   - WS relay push stays the primary path (already sub-second, free). REST is the gap-filler.
   - Visible/subscribed symbols (watchlist, open stock, screener page slice, holdings/positions on screen) poll at **1 s**; off-screen and off-hours drop to 15 s / stop.
   - Server-side coalescing already exists (`quoteCache.ts`); its live TTL drops to ~250 ms so a 1 s poll always gets a fresh print while N users still cost one upstream call.
   - Screener live-filter sweeps (hundreds of symbols) keep the slower bounded cadence — only what you can actually see ticks at 1 s.

3. **No live prices in the DB**
   - Audit and remove any remaining live-quote persistence path; `market-quotes` writes nothing except the provider-health heartbeat.
   - Historical persistence stays on a schedule: **settled daily candles** (already gated to `trade_date < today` in `market-candles`) and **hourly intraday buckets** written once per completed hour rather than per tick.

4. **Backfill-on-open**
   - Opening a stock / chart checks coverage for the requested timeframe (daily history depth, intraday bucket continuity). If rows are missing or stale, the route fires `market-history-backfill` for just that symbol + timeframe, shows a "backfilling…" state, and re-reads when done.
   - Backfill is Kotak-first with Yahoo as historical fallback (history is not the live path, so fallback is acceptable there), deduped per symbol+timeframe so repeated opens don't re-queue.
   - A small coverage badge on the chart states the data source and the last settled bar.

## Technical notes

- `src/lib/market/hooks.ts` — `useQuotes` interval 5 s → 1 s for on-screen keys; add a `visibility`/viewport gate; leave `useQuotesBatched` bounded.
- `src/lib/market/screenerLive.ts` — poll only the current page slice at 1 s, rest at the existing bounded rate.
- `supabase/functions/market-quotes/index.ts`, `_shared/market/resolver.ts`, `_shared/market/provider.ts` — broker-only resolution + typed degradation reason surfaced to the client.
- `supabase/functions/_shared/market/quoteCache.ts` — live TTL 500 ms → 250 ms.
- `supabase/functions/market-candles/index.ts` + `market-history-backfill` — on-demand gap detection and per-symbol backfill trigger.
- `src/routes/market/Analysis.tsx` / chart components — coverage check, backfill trigger, badge.
- Tests in `tests/screenerFilters.test.ts` extended: live filter rejects a non-Kotak value; exact-session gate drops a stale row; broker-only mode returns no Yahoo value for a live filter.

## Question

When Kotak is disconnected on the Screener: auto-open the reconnect modal, or keep the clickable chip only? Default in this plan is chip-only (no modal stealing focus mid-screen), with the modal auto-opening only when you switch into Live mode with no session.
