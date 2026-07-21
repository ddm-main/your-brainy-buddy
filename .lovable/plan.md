## Goal

Rebuild the Screener to match Tickertape's layout and behavior: **left = filters only (add/remove), right = results only**. Fix the data pipeline so filters actually return matches, and validate against your 4-filter Tickertape example (expected 20 results).

## Root cause of "0 results / failed to load"

`useScreenerData` queries `public.market_data`, but that table does not exist in the database — only `market_screener_rows` (view) and `market_stock_scores` (table) do. The `20260721000000_market_multi_provider.sql` migration was never applied. Every filter yields 0 because the query errors before any row is loaded.

The view's column names also differ from what the client expects:
- view uses `close`, `rsi14`, `adx14`, `pe_ttm`, `eps_ttm`, `debt_to_equity`, `revenue_growth_yoy`, `profit_growth_yoy`, `eps_growth_yoy`, `vol_avg20`
- client expects `ltp`, `rsi`, `adx`, `pe`, `eps`, `debt_equity`, `sales_growth`, `profit_growth`, `eps_growth`

So even after pointing to the right source, we must map columns.

## Changes

### 1. Fix data source (unblocks all filters)
- `src/lib/market/screenerRun.ts`: query `market_screener_rows` instead of `market_data`; map view columns → `ScreenerRow` fields (`close→ltp`, `rsi14→rsi`, `adx14→adx`, `pe_ttm→pe`, `eps_ttm→eps`, `debt_to_equity→debt_equity`, `revenue_growth_yoy→sales_growth`, `profit_growth_yoy→profit_growth`, `eps_growth_yoy→eps_growth`, `fii_holding→dii_holding` fallback). Universe filter reads `is_nifty500` from same view.

### 2. Layout — Tickertape-style two-pane, filters-only rail
- `src/routes/market/Screener.tsx`:
  - Remove the top query-chips strip and the "presets / my screens / save / share" toolbar clutter from the main view (move Save/Share/Presets into a small "…" menu in the header).
  - Left rail: **only** shows filters the user has added, each with inline min/max inputs (or slider) and a small X to remove. A single **"+ Add Filter"** button at the bottom opens a searchable picker (category → filter). Nothing else in the left rail.
  - Right pane: results table + pagination + column picker + CSV. No filter chips, no query builder.
  - Universe selector stays as a compact segmented control above filters (needed for Nifty 50 / 500 scoping).
  - Increase left rail width by ~10% (current ~280px → 310px).

### 3. Filter catalog fix
- `screenerCatalog.ts`: verify **1D Return %** (`change_pct`) is present in the "Momentum" category — it is, but was hidden because the sidebar rendered the full catalog. After the "added-filters-only" refactor, it becomes reachable via the Add Filter picker, listed under Momentum with range −20% to +20%.

### 4. Validation
- After the fix, apply the four filters you listed (Mcap 1000–100000, Price 100–10000, 1D Return 5–10%, Volume 100000–10000000) on universe = All Stocks with market closed (so no live overlay drift) and confirm the count.
- I'll run the same query directly against `market_screener_rows` via SQL and compare to Tickertape's 20. If the count differs materially, I'll surface which stocks are missing from your DB vs Tickertape's universe (typically because fundamentals for that symbol haven't synced yet) and note it in-app as a coverage caveat rather than silently under-reporting.

## Out of scope

- No changes to backend sync jobs, edge functions, or the underlying data pipeline.
- Applying the unused `market_data` migration — the view already has everything the screener needs.
- Presets/saved-screener storage schema — kept as-is, just moved into a menu.

## Technical notes

- `ScreenerRow` interface stays the same so `filterMatches`, `HistogramSlider`, and the results table need no changes.
- Column-name mapping happens in one place (the `.map()` inside `useScreenerData`) — no ripple effects.
- Left-rail width lives on a single flex/grid container in `Screener.tsx`.
