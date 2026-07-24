# Stock Screener Correctness Repair

## Confirmed diagnosis

- The app currently evaluates **2,712 active equities** and returns **18 matches for EOD 2026-07-23** under the visible filter set. The ET screenshot is a different market snapshot, so its six rows cannot be used as a same-date expected result.
- A real calculation defect exists: `vol_avg30` is computed as a **30-session median including the current session**, although the filter says **“Volume > 30D Avg Volume.”** Two of the current 18 matches pass the median rule but fail a true prior-30-session average.
- The screener view can combine the latest NSE price row with technical values produced from a different source/date. Price, return, volume, average volume, and technical freshness therefore need one explicit as-of contract.
- The filter UI labels volume as `('000)` while the filter engine compares raw shares, creating a 1,000× interpretation risk.
- Sorting is applied only after pagination, so column sorting rearranges the current page rather than the complete result set; CSV order can also disagree with the table.
- Several filters have no corresponding result column, and enum/boolean scope behavior can retain rows that cannot actually match.

## Implementation

### 1. Make the database view internally consistent
- Replace the current screener view definition through a Supabase migration while retaining `security_invoker=on` and existing grants.
- Establish the latest completed NSE EOD session as the canonical screener date.
- Expose price, previous close, 1D return, and volume from the same NSE EOD row.
- Compute **30-day average volume from the 30 completed sessions preceding the current session**, excluding today; require sufficient history before declaring the boolean filter available.
- Keep market-cap repricing tied to the canonical close and expose clear provenance/as-of fields for price, return, volume, average volume, market cap, fundamentals, and technicals.
- Prevent stale technical rows from being presented as same-session values; retain them only with an explicit technical as-of date and freshness state.

### 2. Correct ingestion calculations
- Change the shared indicator calculation from the current 30-session median to a true prior-30-session arithmetic average.
- Keep daily volume semantics consistent with the selected NSE universe; do not mix BSE volume into the ET-equivalent NSE screen.
- Update the EOD pipeline mapping so newly generated score rows use the corrected average and aligned dates.
- Backfill/recompute affected `vol_avg30` values from stored price history so the fix takes effect immediately rather than only after future syncs.

### 3. Enforce exact filter semantics
- Centralize normalized comparison values and units in `screenerCatalog`.
- Use inclusive bounds for Market Cap ₹1,000–₹100,000 Cr, Price ₹100–₹1,000, and 1D Return 5–15%; use strict `current volume > prior 30-session average` for the boolean rule.
- Make volume inputs and table values consistently use **raw shares** (with readable formatting), removing the misleading `('000)` label unless conversion is performed everywhere.
- Exclude rows with missing/stale required data instead of letting them silently prove a match.
- Fix enum/boolean scope handling so Sector, Industry, F&O, SME, and signal filters exclude out-of-scope rows rather than passing them through as N/A.
- Use one shared equity predicate for filters, coverage, health totals, and universe counts.

### 4. Make results auditable in the UI
- Show the canonical EOD date and a concise “same snapshot required” cue so comparisons against ET are made for the same session.
- Add visible values/columns for every available filter, including 30D average volume and the `Volume > 30D Avg` outcome.
- Ensure active filters always expose the columns needed to verify why each stock matched.
- Display actual per-row as-of lag where stale data is retained and clearly distinguish price freshness from technical/fundamental freshness.
- Preserve the current two-pane HUD layout while correcting labels, count wording, and provenance tooltips.

### 5. Fix sorting, pagination, and export
- Move sorting to the full filtered result collection before pagination.
- Keep the chosen sort stable across pages and page-size changes.
- Export the same fully filtered, globally sorted rows and values shown in the table.
- Use a deterministic default sort for ET parity, such as 1D Return descending when that filter is active, with symbol as a stable tie-breaker.

### 6. Regression and data-parity verification
- Extend indicator tests to prove the prior-30 arithmetic average excludes the current session.
- Extend filter tests for exact boundary inclusion, strict volume comparison, corrected units, missing/stale data, enum/boolean scope, and current-session alignment.
- Add a fixture reproducing the ET filter combination and assert every returned row satisfies all five predicates using the same displayed values.
- Add sorting/pagination/export tests proving global ordering rather than page-local ordering.
- Query the repaired production view after migration, compare raw predicates with frontend output, and verify the live screener in the browser at desktop and mobile widths.
- Report the final same-date match count and any remaining unavoidable differences caused by ET proprietary data sources or timestamp differences; do not hardcode the ET screenshot’s six results.