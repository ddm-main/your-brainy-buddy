# Screener parity, penny exclusion, and egress repair

## Verified findings

- On the latest stored session, the requested Price > ₹100, Market Cap > ₹1,000 Cr, 1D Return > 5%, and raw Volume > 30D Average conditions produce **44 NSE equities**. None are penny-flagged. ET's 45th result therefore needs a symbol-level, same-timestamp comparison; the filter must not be weakened to force the count.
- The UI can diverge because Live mode defaults to a **pace-adjusted** volume test, while ET uses raw cumulative volume versus the full-day average. Identical-looking labels currently represent different formulas.
- Static and live rows are fetched separately. Server bounds narrow only the live plane, then those rows are merged onto a six-hour cached static population. That can omit a valid candidate or retain stale candidate membership.
- The optional liquidity gate can reduce the current 44 matches to 41. It does not explain all of the reported 35, but it is another silent source of parity differences.
- Penny exclusion already exists in the main EOD and aggregate pipelines through `penny_excluded` and `market_universe`. The screener surface does not expose the flag, so the frontend cannot directly enforce the same invariant.
- Current projection and numeric pushdown reduce bytes, but filtered screens still widen to a full candidate load; identity/session fields cross both planes; index membership is fetched separately; and the projection only grows for the lifetime of the tab.

## Implementation plan

### 1. Make the filter formulas deterministic

- Make **Volume > 30D Average** use raw cumulative volume in both Live and EOD modes, matching ET.
- Keep **pace-adjusted volume** as a separately named intraday filter so the formula never changes silently with a mode toggle.
- Apply strict `>`/`<` semantics consistently in database pushdown and client validation, with boundary tests.
- Display the data session and timestamp beside the result count so parity comparisons use the same snapshot.

### 2. Use one authoritative filtered data path

- Add a narrow secured database screener query that applies active universe, non-penny status, session, and supported filters to one coherent row shape.
- Use it for filtered runs instead of intersecting separately fetched static/live candidate sets.
- Keep the lightweight top-300 request for an unfiltered board. Fetch all filtered matches with deterministic keyset pagination.
- Retain client filtering only as a parity assertion, not as the primary result engine.

### 3. Remove pennies before egress

- Derive normal screener, breakout, score, price, backfill, snapshot, and aggregate candidates from the active non-penny universe.
- Exclude penny rows before projection, counting, joins, or network transfer.
- Preserve penny rows only in maintenance/audit flows that identify or rehabilitate them.
- Add an invariant test that normal screener and breakout responses contain no penny-flagged symbol.

### 4. Reconcile 44 versus ET's 45 without compromising accuracy

- Generate a symbol-level parity report with close, previous close, raw return, volume, 30-day average, market cap, session date, and source timestamp.
- Compare it with ET's 45-symbol list at the same minute/session when available.
- Classify the missing/extra symbol as source timing, corporate-action adjustment, market-cap basis, average-volume window, exchange mapping, or strict-boundary behavior; fix the underlying metric only after the row proves the cause.

### 5. Minimize egress

- Push safe numeric, boolean, enum, universe, active, session, and penny predicates into the database.
- Return count and paged rows from the same filtered operation where possible.
- Replace offset pagination with keyset pagination for large runs and CSV export.
- Fold index flags into the screener surface and remove duplicate common fields across filtered data planes.
- Cache settled results by session plus normalized filter hash; cache live results by promoted sweep ID and invalidate only when that ID changes.
- Replace the permanently widening tab projection with bounded cached query shapes.
- Add byte telemetry and budgets for the board, four-filter parity screen, subsequent pages, and CSV export.

### 6. Tests and verification

- Add regressions for the exact four-filter screen, raw versus paced volume, strict thresholds, stale cache, newly crossing candidates, liquidity mode, missing averages, and penny exclusion.
- Verify database count, API count, visible count, CSV count, and symbol sets are identical for the same session and filter hash.
- Re-run the screen against both the latest settled session and current live sweep, explicitly report their timestamp-driven differences, and confirm responses remain within the egress budget.

## Technical details

- Database migration: create/update the secured screener query surface with authenticated/service-role grants, RLS/security-invoker behavior, and no sensitive columns.
- Frontend: simplify `screenerRun.ts` around the authoritative query; split raw and paced volume definitions in `screenerCatalog.ts`; update Screener controls and result metadata.
- Pipeline audit: modify only market-data readers that still bypass `market_universe` or `penny_excluded`; retain explicit penny-maintenance jobs.
- No result tolerance or rounding shortcut will be introduced merely to mimic ET's count.