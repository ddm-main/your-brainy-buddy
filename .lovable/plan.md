# Screener correctness: one value plane, clean universe, verified parity

## Verified diagnosis

- The live sweep is healthy again: the latest runs complete with 1,441 scanned and 1,440 priced.
- The database itself returns 31 rows for the filters visible in the screenshot (`market cap ≥ 1,000`, `price ≥ 100`, `1D return ≥ 5%`, `volume greater than 30D average`). That count is therefore not a frontend filtering failure.
- The apparent threshold violation is real at the presentation layer: APARINDS is currently `+4.926%` on the promoted sweep and does not pass the database filter, but the table can repaint visible rows with a newer Kotak tick. This allows a row admitted at one value to display another value after filtering.
- The reference screen and the app are not applying identical filters. The Economic Times capture uses bounded ranges and a raw volume range; the app screenshot uses open-ended minimums plus `volume greater than 30D average`. With the stated bounded filters (`market cap 1,000–100,000`, `price 100–10,000`, `1D return 5–10%`, `volume 100,000–10,000,000`), the current app data returns 25 rows, not 31.
- The claimed 1,441-stock clean universe is not clean under the requested rule. It contains 5 rows with market cap below ₹1,000 Cr and 90 rows with price below ₹50 (95 violations total). Some low-price rows also lack market cap, so positive-proof eligibility is not being enforced consistently.

## Fix plan

### 1. Make filter and display values identical

- Remove the sub-minute quote override from sortable/filterable Price and 1D Return cells.
- Render, sort, export, and filter exclusively from the promoted sweep row in Live mode and the settled row in EOD mode.
- Keep fresh Kotak ticks only as secondary, explicitly labeled information that cannot replace the authoritative table value or affect ordering.
- Add regression tests proving a stock admitted above 5% cannot later display below 5% in the same result set.

### 2. Make filter semantics explicit and reproducible

- Keep numeric minimum and maximum bounds exactly as entered; validate and normalize swapped bounds.
- Show a compact active-filter summary above results so `volume greater than 30D average` cannot be mistaken for a fixed raw-volume range.
- Add a one-click ET-parity preset with the exact four bounded filters requested: market cap 1,000–100,000; price 100–10,000; 1D return 5–10%; volume 100,000–10,000,000.
- Ensure the query pushdown and final client predicate use the same canonical field and inclusive-bound rules.

### 3. Repair the authoritative stock universe

- Re-run eligibility using positive proof: market cap must be at least ₹1,000 Cr and LTP must be at least ₹50; null evidence is not eligible.
- Remove every violating symbol from active universe membership and purge it from downstream market planes using the existing penny-purge path.
- Record exclusions with a reason, then refresh the screener snapshot and live-sweep snapshot.
- Do not hard-code 1,441 as the target. Display and sweep the actual eligible count after cleanup; correctness takes priority over preserving a stale denominator.

### 4. Preserve low egress

- Continue one narrow static fetch per session and one narrow live-plane fetch per five-minute sweep.
- Keep server-side numeric pushdown and paged reads; do not add full-universe quote polling.
- Restrict sub-minute quote retrieval to drill-down/watchlist surfaces, not screener result cells.
- Verify each screener response remains below the 128 KB guardrail.

### 5. End-to-end verification

- Run unit tests for inclusive bounds, raw/display equality, Live/EOD projection, and saved-filter normalization.
- Query the final database result for both the screenshot filters and the exact ET bounded preset; compare the rendered symbols and values row-for-row.
- Confirm zero active-universe rows violate either penny threshold.
- Confirm a fresh sweep completes against the new eligible count and that all rendered 1D returns satisfy their visible bounds.
- Compare against Economic Times at the same minute; list remaining differences only when attributable to source timing, exchange basis, or universe policy.

## Technical scope

- Frontend: `src/routes/market/Screener.tsx`, `src/lib/market/screenerCatalog.ts`, `src/lib/market/screenerRun.ts`.
- Tests: screener filter/projection regression coverage.
- Database: an approved migration/RPC invocation using the existing exclusion and purge framework; no user portfolio, order, or settled-price data outside excluded symbols is touched.
- Edge functions: invalidate/rebuild the sweep snapshot only if required after universe cleanup.