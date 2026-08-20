# Screener parity: canonical NSE sessions, deterministic filters, explainable differences

## Verified diagnosis

- The two screenshots are not evaluating one identical market snapshot. JARVIS is tied to a promoted five-minute Kotak sweep, while the Economic Times capture has no matching snapshot identifier or timestamp. During the investigation JARVIS moved from 12 displayed matches at 10:25 IST to 10 database matches at 10:30 IST as several symbols crossed the 6% boundary.
- JARVIS currently shows `12 of 16`, even though the core candidate RPC and the final client predicate are intended to apply the same four conditions. That is an internal invariant failure: rows admitted by the authoritative RPC can still be removed after the static/live merge and client re-filter.
- The comparison also contains real universe differences. Examples from the ET result are absent or intentionally outside JARVIS's proven universe: Behari Lal Engineering has no market-cap proof and `in_universe=false`; Kavita/Kavach Defence is excluded below the ₹1,000 Cr policy; other ET names are not present under the same current NSE symbol identity. They must not be silently added in violation of the no-penny rule.
- The active universe is not currently clean: the database reports 1,343 active/in-universe NSE equities, with 7 rows violating `market cap >= ₹1,000 Cr AND LTP >= ₹50`. The latest promoted sweep still reports an expected population of 1,344 and prices 1,343, so the UI denominator and current eligible rows are out of sync.
- The stored `vol_avg30` does not consistently equal the latest 30 valid NSE sessions reconstructed from daily rows. The history also contains non-trading-day dates, so “Volume > 30D Avg” is not yet a trustworthy ET-comparable definition even though both the RPC and UI label it as one.
- The latest live sweep itself is operational: it completes every five minutes with 1,344 scanned, 1,343 priced, and one failure. The remaining problem is semantics and population consistency, not a frozen feed.

## Fix plan

### 1. Establish one canonical screener snapshot

- Make the database RPC return a snapshot token, session/as-of time, eligible-universe count, candidate count, and every authoritative filter value from one completed sweep.
- Keep that fixed candidate set through the static/fundamental join; do not let a later view read, stale cache entry, or client projection change membership.
- Reduce the client pass to an assertion of the same canonical predicate. If any RPC row fails it, surface a development diagnostic with the symbol, field, RPC value, projected value, and snapshot token rather than silently producing `12 of 16`.
- In the UI, show one unambiguous count (`12 matches`) and the exact snapshot time. Reserve “of N” for the eligible universe, not an intermediate candidate set.

### 2. Correct “Volume > 30D Avg”

- Define the rule as: current cumulative NSE session volume strictly greater than the arithmetic mean of the previous 30 completed, valid NSE trading sessions; exclude the current partial session from the average.
- Rebuild `vol_avg30` from authoritative NSE session rows, rejecting weekends, holidays, duplicate dates, zero-volume artifacts, and non-equity series.
- Validate the Kotak quote field used by the live sweep is cumulative traded volume, not last-trade quantity or interval volume; reject implausible regressions within a session.
- Use this same stored average and live cumulative volume in the RPC, displayed columns, CSV export, filter chips, and regression tests.

### 3. Repair and synchronize the eligible universe

- Re-run positive-proof eligibility: active NSE EQ, current market cap at least ₹1,000 Cr, and current LTP at least ₹50; null evidence remains ineligible.
- Exclude and purge the 7 confirmed threshold violators through the existing penny-stock workflow, then rebuild the sweep snapshot so `expected_count`, priced population, database count, and UI denominator agree.
- Add a symbol-identity audit for ET-only names (renames, new listings, trusts/non-equities, and genuinely missing master rows). Admit only rows that satisfy the existing eligibility policy; record a reason for every rejected comparison symbol.
- Do not hard-code 1,344 or the older 1,441 count. The displayed universe count must come from the same snapshot used for filtering.

### 4. Make external differences explainable

- Add a compact “Compare snapshot” diagnostic that lists matched symbols and exclusions by reason: below threshold, volume not above average, stale/missing quote, missing market-cap proof, non-EQ instrument, or absent symbol mapping.
- Clearly state source and basis: NSE, Kotak five-minute sweep, strict `volume > average`, and inclusive numeric thresholds (`>= 100`, `>= 1,000`, `>= 6`). Economic Times cannot be guaranteed symbol-for-symbol unless its source timestamp, universe, corporate-action basis, and 30-day methodology are identical.
- Preserve the current low-egress architecture: return only matching rows plus compact reason counts; fetch row-level diagnostics only when the comparison panel is opened.

### 5. Verification

- Add unit tests proving RPC/client parity, strict volume comparison, inclusive numeric boundaries, raw/display equality, URL-restored filters, and no membership drift during a sweep refresh.
- Add database checks for exactly 30 valid prior NSE sessions, no weekend/holiday inputs, zero penny-universe violations, and equality between universe count and sweep expected count.
- Run a fresh sweep and verify every rendered row satisfies all four visible filters using the values printed in that row.
- Reconcile the supplied ET list symbol-by-symbol at the closest available timestamp and document only legitimate source/universe differences after internal mismatches are zero.
- Verify the screener response remains below the 128 KB per-response guardrail and does not add full-universe polling.

## Technical scope

- Frontend: `src/routes/market/Screener.tsx`, `src/lib/market/screenerRun.ts`, `src/lib/market/screenerCatalog.ts`.
- Tests: screener filter/projection/snapshot regressions.
- Database: revise the core-candidate RPC, canonical 30-session volume calculation, and universe/sweep consistency checks through an approved migration.
- Edge function: update `market-live-sweep` only where cumulative-volume validation and snapshot population rebuilding require it.
