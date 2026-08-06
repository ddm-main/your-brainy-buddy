# Screener ↔ ET parity — full implementation (all phases)

## Verified current state

- Live plane is populated, not empty: 2,564 rows in `market_live_prices`, 2,564 staged rows, 1 completed run.
- That run promoted cleanly: scanned 2,568, priced 2,564, Kotak 2,564, Yahoo 0, failed 4 — 99.84% coverage of the active NSE EQ universe (2,568 EQ of 2,800 active NSE rows).
- `market-live-sweep` answers 401, not 404 — deployed and auth-gated. Phase 1's deploy blocker is resolved.
- Cron already registered and active: pre-open 03:40 UTC, every 5 min 03–09 UTC Mon–Fri, post-close 10:05 UTC.
- `market_screener_rows` already coalesces the live plane into `close`, `previous_close`, `change_abs`, `change_pct`, `volume`, and adjusts `market_cap` by live LTP. It exposes `live_provider` and `live_as_of` but no `sweep_id`, no live volume, no quote-state marker.
- Frontend still runs the legacy path: `useScreenerLiveQuotes` with `LIVE_QUOTE_CAP = 1000` plus a `filterMatchesLive` second pass, and the per-row `STALE` badge.
- `market-data-validation` still selects from and updates the removed `market_data` table (lines 37 and 90) — the source of the `PGRST205` errors.

## Step 1 — database (runs first)

One non-destructive `CREATE OR REPLACE VIEW` on `market_screener_rows`, all existing columns unchanged, adding:

- `live_sweep_id`, `live_session_date`, `live_volume`
- `quote_state`: `live` when the promoted sweep priced the symbol, `eod` when only the settled bar exists, `no_quote` when neither

No table changes, no data rewrite, no history touched. Grants re-issued for `authenticated`, `anon`, `service_role`.

## Step 2 — one coherent Screener source (Phase 3)

- `screenerRun.ts` projects the new columns and maps them onto `ScreenerRow` (`quote_state`, `live_sweep_id`, `live_as_of`, `live_volume`).
- Delete `src/lib/market/screenerLive.ts`, the `useScreenerLiveQuotes` call, the 1,000-symbol cap and the `filterMatchesLive` second pass in `Screener.tsx`. Live filters then evaluate the same row values the table renders.
- Filtering, sorting, pagination and CSV export all read one row model.
- Visible-row WebSocket ticks stay display-only and cannot affect membership or sort order.

## Step 3 — honest freshness UI (Phase 4)

- Remove the per-row `STALE` badge and the split-session exclusion banner.
- Add one plane-level status chip fed by the newest `complete` run in `market_live_price_runs`: `as_of`, session date, coverage %, Kotak / Yahoo / failed counts.
- `quote_state = 'no_quote'` renders as "no quote" — never an old value presented as live.
- EOD mode reads only the last settled bhavcopy session.
- Shares / thousands volume display toggle that does not change filter arithmetic.

## Step 4 — repair validation (Phase 5)

Rewrite `supabase/functions/market-data-validation/index.ts` against current tables (`market_stocks`, `market_live_prices`, `market_live_price_runs`, `market_daily_prices`, `market_stock_scores`, `market_screener_rows`); every `market_data` reference removed. Checks:

- duplicate and missing symbols vs the active NSE EQ universe
- live-plane coverage and mixed `sweep_id` detection
- invalid OHLC and invalid settled anchors (`prev_close <= 0`)
- `change_pct = (ltp - prev_close) / prev_close × 100` drift on the promoted plane
- the 4 failed symbols from the last sweep, reported by name

Read-only by default; repairs only under an explicit `{ "repair": true }` flag, and logged.

## Step 5 — schedule hardening (Phase 2 gap)

- Confirm overlap rejection (a new cron run cannot race an unfinished sweep); add the guard if `begin_market_live_sweep` doesn't already enforce it.
- Surface last-run duration and health in Config diagnostics.

## Step 6 — authenticated parity verification (Phase 6)

- Sign in with the supplied account via a headless browser run and apply the ET filter set: Price > ₹100, MCap > ₹1,000 Cr, 1D > 8%, Volume > 30D Avg.
- Cross-check sampled rows against the database, naming a cause for each residual mismatch (universe, quote, settled anchor, shares outstanding, volume timing, provider delay).
- Exercise sorting, pagination, CSV, Live/EOD switching, empty and error states, desktop and mobile widths.
- Reconcile renamed/missing NSE symbols (Glenmark Life) against NSE master rather than inserting a stale alias.

## Data-safety rules kept

No destructive migration, no historical-price rewrite. The live plane stays upsert-in-place and ephemeral; settled daily history stays authoritative. Promotion remains the only publication boundary.

## Files touched

`supabase/functions/market-data-validation/index.ts`, `src/lib/market/screenerRun.ts`, `src/routes/market/Screener.tsx`, `src/lib/market/screenerLive.ts` (removed), plus the single view migration.
