# Screener vs Economic Times — why the lists differ, and the fixes

## What I verified in the live system (2026-08-11, ~15:05 IST)

1. **The live plane is frozen at 13:45 IST.** Every row in `market_live_prices` carries one timestamp: 08:15 UTC (13:45 IST), 1,821 rows. Every sweep since then has **failed** with `coverage below promotion floor (169/1710 = 0.0988)`, once every 5 minutes.
2. **Cause of the failure:** the sweep only quotes the *watched* set — `market_live_watch_universe()` returns **169 symbols** (watchlists, holdings, positions, alerts, index members) — while `promote_market_live_sweep` measures coverage against the **1,710-name mainboard universe**. 169/1,710 = 9.9%, below both the 98% full floor and the 50% partial floor, so nothing is ever published and the whole plane stays at 13:45.
3. **That alone explains most of the ET diff.** At 13:45 Unichem was −0.61%, TCPL Packaging −0.15%, Finolex Cables +0.16%; ET (captured later) shows +11.21%, +11.84%, +12.77%. Our stale numbers fail the "1D > 5%" gate — same story for Affle, Carborundum, PNC Infratech, Nilkamal, Policy Bazaar, Quality Power, Zydus, Dolphin, Frontier Springs, Turtlemint, Gujarat Natural.
4. **1,002 active NSE EQ symbols can never appear.** `market_screener_rows` is built on `market_stock_scores`; 1,002 of the 2,802 active EQ names have no score row (hence "of 1826" on the board). Matrimony.com (`MATRIMONY`) and Abans Enterprises (`ABANSENT`) — both on ET's list — are invisible for this reason.
5. **`vol_avg30 IS NULL` silently means "fails the volume filter".** Juniper Green Energy (`JNPR`, +7.76%, ₹14,665 Cr) has no 30-day average, so `Volume > 30D Avg` evaluates false instead of "unknown".
6. **Corrupt reference data on some rows.** Cupid Ltd shows market cap **₹37,193 Cr** (ET: ₹1,117 Cr) and a 30-day average volume of **40.0 M** shares — both wrong, which flips it in and out of screens. Gujarat Natural's 30-day average also looks inflated.
7. **The liquidity gate hides ET names.** `is_liquid_tradable = false` rows (Gandhi Special Tubes, Juniper Green) are hidden by default.
8. **Volume units differ.** ET prints '000; the screener prints raw shares — a threshold copied from ET is 1,000x off.

## The fix

### 1. Restore a full-universe five-minute sweep (root cause)

- Build the sweep snapshot from the full active NSE EQ mainboard universe again, not the 169-name watched set, chunked and chained as it already is.
- Take `expected_count` from the **snapshot the sweep actually iterates**, so coverage arithmetic can never compare one universe against another again. Short coverage then means a real upstream problem, not a definitional mismatch.
- Chained chunks keep one `sweep_id` and one `as_of`; promotion stays the only publication boundary; a failed sweep still leaves the previous plane intact.
- Watched symbols are priced first inside the sweep so held names survive a late-chunk failure.

### 2. Make staleness impossible to miss

- The status chip states sweep time **and age in minutes**, plus priced/expected coverage; past a threshold (default 10 min) it becomes an explicit warning that filters are running on old prices.
- Consecutive sweep failures surface in Config diagnostics with the last error text, instead of only living in `market_live_price_runs`.

### 3. Volume filter honesty

- Add a shares / '000 unit toggle next to the volume filter and column. Display-only: stored values and filter arithmetic unchanged, the label states which unit the threshold is in.
- `Volume > 30D Avg` distinguishes **false** from **unknown**: a row with no 30-day average is reported as unjudgeable (and counted in the excluded total) rather than quietly failing.

### 4. Universe backfill (non-penny, liquid only)

- Score-backfill the missing symbols that clear the existing non-penny / liquidity floor, so names like Matrimony.com enter the board; genuine micro-caps stay out.
- Report how many active symbols are excluded and why (no score row, penny, illiquid), so a missing ET name is explainable rather than invisible.

### 5. Reference-data audit

- Add a validation check for market-cap and 30-day-volume outliers (live cap vs reported cap, cap implied by shares × price, avg volume vs median), starting with Cupid and Gujarat Natural, and correct the underlying shares-outstanding / volume rows it flags.
- Report offenders from `market-data-validation` instead of letting them silently distort screens.

### 6. Egress budget: correct results, minimum bytes

Accuracy is never traded away — only bytes and, where needed, a little latency. Verified problems and the improvements that fix them:

**Server side (sweep, ~1,710 symbols every 5 min)**

- Build the session snapshot **once per session** (universe, settled anchors, Kotak tokens) and address chunks by index — already the design, so the full-universe restore reuses it instead of re-reading reference data 12 times an hour.
- Raise the chunk size to the 400-symbol ceiling so a full sweep is ~5 chained invocations, not ~9, cutting per-chunk snapshot/settings reads proportionally.
- **Write only what changed:** stage rows whose `ltp`, `volume` and `change_pct` are identical to the currently promoted row are skipped, so a thin-volume name that has not printed since the last sweep costs no write. Coverage counting still counts it as priced (its promoted row is current), so promotion stays honest.
- Keep the Yahoo gap-filler capped per invocation (unchanged) and broker-only quoting, so a broker outage cannot fan out into thousands of upstream calls.
- Prices go out to the provider in batched quote calls (existing `QUOTE_CHUNK`); no per-symbol requests are added.
- Tail-end symbols with no trades for the session are swept on a **slower cadence** (every 3rd sweep) once the market has been open an hour — a genuinely untraded name cannot change a price/return/volume screen, and a little delay there is acceptable.

**Client side (this is where the budget errors are coming from)**

The console currently shows repeated `BUDGET: market_screener_rows → 183.2 KB / 151.2 KB / 234.2 KB in one response (ceiling 128 KB)`. The static plane is already cached and the projection already narrows columns; what remains is row volume. Improvements:

- **Push the active filters to the server.** The four thresholds in your screen (price, market cap, 1D %, volume vs 30D avg) become `.gt()` filters on `market_screener_rows`, so the response is the ~35 matching rows instead of all 1,826. This is the single biggest saving and removes the budget breach outright.
- Client-side evaluation stays as the authority for display consistency, but it now runs over rows the server already narrowed — the same values, far fewer of them.
- Keep pagination server-side (`range`) with the existing order, so page 2 costs one page, not another full universe.
- Split the poll: the live plane's small delta (symbol, ltp, change, volume, as_of) refreshes on the 5-minute cadence for **visible rows plus filter-relevant columns only**; static columns keep their session-long cache.
- Drop the duplicate visible-page quote map: WebSocket ticks already cover visible rows and are display-only.
- CSV export and "load all" remain explicit opt-ins that fetch wide data, never the default path.
- The volume-unit toggle and the age chip are pure presentation — zero extra requests.

**Backfill and audit**

- The score backfill runs in bounded batches on the existing off-hours schedule, and the reference-data audit runs as a server-side aggregate query that returns only flagged symbols, not the universe.

Expected effect: the screener's per-refresh payload drops from ~180–230 KB to well under the 128 KB ceiling (a filtered run is a few KB), and the sweep's own reference-read overhead falls roughly by half while covering 10x more symbols.

### 7. Parity re-check at one timestamp

Re-run ET's screen (Price > 100, MCap > ₹1,000 Cr, 1D > 5%, Volume > 30D Avg) in Live mode against an ET capture at the same minute and produce a symbol-by-symbol diff, with a named cause for every remaining difference (ET's own universe, unit basis, provider delay).

## Technical notes

- Touched: `supabase/functions/_shared/market/sweepSnapshot.ts` (universe source), `supabase/functions/market-live-sweep/index.ts` (expected-count accounting, ordering), `begin_market_live_sweep` / `promote_market_live_sweep` (expected count from the snapshot), `src/routes/market/Screener.tsx` and `src/lib/market/screenerCatalog.ts` (age chip, volume unit toggle, unknown-vs-false volume gate), `supabase/functions/market-data-validation` (outlier + universe-gap checks).
- No destructive migration: settled daily history, scores, holdings and user data untouched; the live plane stays upsert-in-place with promotion as the only publication boundary.
- Cost note: full-universe five-minute sweeping is the expensive option you chose; section 6 offsets it — server-side filter pushdown, change-only staging, larger chunks, one snapshot per session, and a slower cadence for untraded tails. No filter or displayed value changes as a result; only byte counts and, in the untraded tail, freshness by a few minutes.

## Done when

- A five-minute sweep publishes a complete plane continuously during the session, and the screener's chip shows an age in single-digit minutes.
- The ET benchmark screen in Live mode matches ET name-for-name at the same minute, apart from differences with a stated cause.
- No `[egress] BUDGET` warning appears for a normal filtered screener run, and results are identical to the unoptimised path on a sampled comparison.