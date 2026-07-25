## Goal
Make the J.A.R.V.I.S. Market Screener match the Tickertape result set for the shown filters without risking existing market/finance data.

## Verified findings
- The database currently returns the same 10 Tickertape symbols when the volume condition is treated as `Volume >= 100,000` rather than a capped `100,000–1,000,000` range.
- The app’s strict volume upper bound is why high-volume matches like MARKSANS, MEDPLUS, TIPSMUSIC, MHRIL, OSWALPUMPS, ORIENTHOT, and BAJAJHCARE disappear.
- GENESYS appears only because its rounded 1D return is `-7.00`; Tickertape excludes it for a `-15% to -7%` negative-return range, implying the upper negative-return edge should be treated strictly using the raw unrounded value.
- Data is read-only for this fix. No deletes, no destructive migrations, and no financial records are modified.

## Implementation plan
1. **Filter semantics fix**
   - Update the screener filter catalog so the Volume filter’s UI max of `1,000,000` behaves like Tickertape’s `1M+` open-ended cap.
   - Keep manual lower-bound filtering working normally.

2. **1D return edge fix**
   - Add support for using a raw unrounded `change_pct` value for comparisons while still displaying the rounded value in the table.
   - Update the screener data mapping to include that raw value when available.
   - This prevents `-6.999...` from being rounded to `-7.00` and incorrectly passing a `<= -7` style screen.

3. **Regression coverage**
   - Add tests for the exact parity behavior:
     - `Volume min 100k + max 1M` keeps stocks above 1M volume.
     - Raw `-6.999...` 1D return does not pass the `-15 to -7` negative range.
     - The 10-symbol Tickertape-like DB query remains the reference expectation.

4. **Verification**
   - Run targeted screener filter tests.
   - Re-query Supabase to confirm the expected symbols are: MARKSANS, MEDPLUS, TIPSMUSIC, MHRIL, SUNTECK, OSWALPUMPS, UNICHEMLAB, ORIENTHOT, INDOBORAX, BAJAJHCARE.
   - Use the preview/browser to verify the Market Screener shows `Results · 10` with the same filters.

## Data safety
- No database writes are needed for the parity fix.
- The only code changes are frontend filter/data-mapping logic and tests.
- I will not change ingestion pipelines, cron jobs, or source market data in this step.