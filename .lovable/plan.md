# Screener parity: authoritative results, no hidden exclusions

## Verified diagnosis

- The live pipeline is healthy: the latest sweep completed for 1,350 rows, scanned 1,350, and priced 1,349.
- At the verified 2026-08-13 06:25 UTC sweep, the database returns **27** rows for the literal rules shown: NSE equity, Price at least ₹100, Market Cap at least ₹1,000 Cr, 1D Return at least 5%, and cumulative Volume above the 30-day average.
- The UI then silently applies `is_liquid_tradable !== false`, removing **JUBLCPL** and **ZSARACOM**. This makes the displayed count **25** even though liquidity is not one of the selected filters.
- The current active NSE equity universe is **1,349**, not 1,441. Four active rows currently fall below ₹1,000 Cr and one row lacks the positive price/cap proof required by the non-penny policy.
- The existing `market_screener_et_parity` database function already expresses the core parity query, but it has no callable grant. The frontend therefore recreates the query through two independently fetched planes and a second client-side predicate.
- Exact external parity requires matching timestamp, exchange, universe, market-cap basis, price source, and 30-day-volume formula. The app currently does not disclose enough of that basis to explain legitimate source-time differences.

## Fix plan

### 1. Make selected filters the complete result contract

- Remove the unconditional hidden-liquidity gate from Screener results.
- Expose “Liquid tradable only” as a normal, visible filter; apply it only when selected.
- Ensure result count, table rows, pagination, sorting, and CSV export all use the same final symbol set.
- Add regression coverage proving that no row is removed by an unselected condition.

### 2. Use one authoritative server result for the parity filters

- Secure and grant the existing parity function to authenticated users only.
- Extend it to accept literal inclusive minimum/maximum bounds for Price, Market Cap, 1D Return, raw Volume, and Volume above 30D Average, using typed parameters and no dynamic SQL.
- Return the promoted `sweep_id`, `live_as_of`, provider basis, and exact matching symbols from one database snapshot.
- Use that result as the candidate set whenever these live core filters are active; apply additional fundamental/technical filters without changing the authoritative live values.
- Keep keyset pagination and narrow projections so every response remains below the 128 KB egress ceiling.

### 3. Eliminate two-plane timing drift

- Pin the live query to one promoted sweep rather than reading whichever sweep is current during each independent request.
- Prevent static-cache rows or a later poll from changing Price, 1D Return, Volume, or Market Cap for an already-produced result set.
- Invalidate the result only when the next complete sweep is promoted; update count and rows together.

### 4. Repair the non-penny universe invariant

- Re-run positive-proof eligibility: active membership requires Market Cap at least ₹1,000 Cr and LTP at least ₹50; null proof is not eligible.
- Exclude/purge the four below-cap rows and the one unproven row through the existing penny-exclusion path, then rebuild the screener snapshot.
- Treat the resulting count as authoritative; do not force a stale target of 1,441.
- Add database verification that active universe membership has zero threshold violations after rebuild.

### 5. Make external differences auditable

- Show a compact result-basis line: promoted sweep time in IST, exchange, live provider mix, universe count, raw/inclusive volume rule, and whether liquidity filtering is active.
- Add a comparison export containing symbol, exact raw values, sweep time, and exclusion reason.
- For ET comparisons, capture both screens at the same minute and categorize every symbol difference as timing, source price, market-cap basis, universe membership, volume baseline, or explicit filter.

### 6. Verify end to end

- Unit-test inclusive boundaries, raw volume semantics, optional liquidity filtering, candidate-set stability, and export parity.
- Compare the server function’s symbols row-for-row with the rendered table and CSV.
- Verify a promoted next sweep replaces the entire result atomically.
- Confirm zero active-universe penny violations and no screener response above 128 KB.
- Run a same-minute ET comparison and document remaining provider/universe differences without claiming cross-provider identity where snapshots differ.

## Technical scope

- Frontend: `src/routes/market/Screener.tsx`, `src/lib/market/screenerRun.ts`, filter catalogue/column mapping, screener regression tests.
- Database: update/grant `market_screener_et_parity`; invoke the existing exclusion/purge and snapshot-refresh framework.
- No changes to holdings, orders, positions, or settled historical prices except downstream rows belonging to newly excluded penny symbols.