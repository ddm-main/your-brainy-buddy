## Change

In `src/routes/market/Dashboard.tsx`, make the Top Breakouts table's columns reflect the **active filters** of the selected saved screener.

## Rules

- Always keep: **Symbol** (first column) and **Breakout** (last column).
- Between them, render one column per active filter in the screener, in the same order the filters appear in the screener state (`selectedScreenState.active`).
- Deduplicate: if the same filter id is active twice, render its column once.
- Skip filters that don't have a meaningful row value (e.g. pure boolean signal columns with no numeric value) by still rendering a compact chip (Yes/No) using the row's value — this keeps the column list == filter list.
- If the screener has zero active filters, the current empty state already fires; no columns to render beyond Symbol + Breakout (table stays empty anyway).

## Column derivation

Build a small `filterColumn(filterId)` helper that returns a `ColumnDef` using:

- `FILTER_BY_ID[canonicalFilterId(id)]` from `src/lib/market/screenerCatalog.ts` for label, kind, unit, and `valueKey`.
- Value accessor: `def.valueKey ? row[def.valueKey] ?? row[def.id] : row[def.id]`, plus the existing live-quote overlay for `ltp` and `change_pct` (reuse `liveFor(row)?.ltp` / `liveFor(row)?.change_pct`).
- Cell rendering:
  - `change_pct`, `ret_5d`, `ret_21d`, `ret_ytd`, `dividend_yield`, growth/return %s → `<PctCell />`
  - other numbers → `fmtNum(value)` with unit suffix (e.g. `"12.3x"`, `"₹500.75"`, `"1,234 Cr"`) driven by `def.unit`
  - `boolean` → "Yes" / "No" chip
  - `enum` → raw string
- `meta: { align: "right" }` for numbers/booleans; left for enums.

## Memoization

Replace the current static `breakoutColumns` memo (Dashboard.tsx ~302–327) with one that depends on `selectedScreenState.active` and `liveByKey`, composing: `[symbolCol, ...activeFilterCols, breakoutCol]`.

## Scope guardrails

- No change to filtering logic, screener editing, or the Screener route.
- No change to `DataTable`, `HudPanel`, or other cards on the Dashboard.
- No new dependencies.

## Why this is right

The card already only renders rows that pass every active filter. Making the columns mirror those same filters means the user sees exactly the values that qualified each row — nothing more, nothing less — with Breakout kept as the invariant ranking column.
