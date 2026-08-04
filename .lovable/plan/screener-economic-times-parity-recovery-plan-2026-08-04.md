# Screener ↔ Economic Times parity — recovery plan

## Verified current state

- Atomic backend exists: `market_live_prices`, `market_live_price_runs`, `market_live_price_stage` are all present.
- The live plane is empty: **0 live rows, 0 runs, 0 staged rows**. Active NSE universe is **2,800** rows (`is_active`, exchange NSE); the tradable EQ subset is smaller and must be pinned during Phase 5.
- `market-live-sweep` is declared in `supabase/config.toml` and present in source, but the deployed endpoint returns **404**. No frontend cutover is safe until this is fixed.
- `market-data-validation` still reads and writes the removed `market_data` table (lines 37 and 90), which matches the `PGRST205` errors.
- The Screener still runs the legacy capped candidate-quote path plus a separate visible-row overlay, and still shows the per-row `STALE` badge and split-session logic.

## Phase 1 — activate and prove the atomic live plane

- Resolve the deploy/config mismatch until `market-live-sweep` responds instead of 404.
- Run one small non-chained sweep; verify run/stage counters, provider counts, settled anchors, and error reporting.
- Run one full chained sweep and require successful atomic promotion before touching the UI.
- Hard gates: single promoted `sweep_id` / `session_date` / `as_of`; ≥98% coverage of the active EQ universe; no partial stage rows visible through `market_live_prices`; `change_pct = (ltp - prev_close) / prev_close × 100` on sampled symbols; overlapping sweeps rejected safely.
- If any gate fails, leave the Screener data path unchanged and surface the failure in Config/health diagnostics.

## Phase 2 — schedule the session safely

- Register the 5-minute session schedule only after a manual full sweep passes.
- Add pre-open seeding and a post-close final sweep; no forming prices written into settled daily tables.
- Track run duration and add overlap protection so a new cron run cannot race an unfinished sweep.
- Keep bounded Yahoo fallback; report Kotak / Yahoo / failed counts per promoted run.

## Phase 3 — one coherent Screener source

- Confirm `market_screener_rows` projects live-plane `ltp`, `prev_close`, `change_abs`, `change_pct`, `volume`, provider, sweep id and timestamp alongside settled technical/fundamental fields.
- Point the frontend projection and row model at those fields directly.
- Remove the candidate-wide `useScreenerLiveQuotes` path, the 1,000-symbol cap, and the `filterMatchesLive` second pass.
- Filtering, sorting, CSV export and displayed Price / 1D Return / Volume all read the same row values.
- Visible-row WebSocket ticks stay only if they cannot affect membership or sorting; otherwise they are removed from this page.

## Phase 4 — honest freshness UI

- Remove the per-row `STALE` badge and the split-session exclusion banner.
- Show one plane-level status chip: live timestamp, session, coverage, Kotak/Yahoo counts.
- Mark symbols absent from the promoted sweep as `no quote`; never present an old value as live.
- Keep an explicit EOD mode backed only by the last settled bhavcopy session.
- Add the shares / thousands volume display toggle without changing filter arithmetic.

## Phase 5 — repair validation and universe coverage

- Rewrite `market-data-validation` against current tables (`market_stocks`, `market_live_prices`, `market_daily_prices`, `market_stock_scores`, screener view); remove every `market_data` reference.
- Validate universe gaps, duplicate symbols, plane coverage, mixed sweep ids, invalid OHLC, invalid settled anchors, arithmetic drift.
- Reconcile the active NSE EQ universe against NSE master/bhavcopy; resolve missing or renamed symbols (including Glenmark Life's current identity) instead of inserting a stale alias.
- Validation is read-only by default; repairs are explicit and audited.

## Phase 6 — authenticated parity verification

- Run the ET filter set against the promoted plane: Price > ₹100, MCap > ₹1,000 Cr, 1D > 8%, Volume > 30D Avg.
- Diff every expected ET symbol and value with a named cause for each residual mismatch: universe, quote, settled anchor, shares outstanding, volume timing, or provider delay.
- Verify filtering, sorting, pagination, CSV, Live/EOD switching, empty/error states, desktop and mobile rendering.
- Accept completion only when there is no partial-session exclusion, no stale-badge inversion, no candidate cap, and sampled arithmetic matches database rows exactly.

## Data-safety rules

- No destructive migration or historical-price rewrite.
- The live plane stays upsert-in-place and ephemeral; settled daily history stays authoritative and untouched.
- Staged/partial sweeps are never exposed — promotion is the only publication boundary.
- Cron and frontend cutover stay off until manual sweep verification passes.
- The current Screener path remains as rollback until authenticated ET verification succeeds.
