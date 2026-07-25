# 1D Return — Unified "+abs (+pct%)" Display

## Goal

Everywhere 1D return is rendered in the app, show absolute rupee change alongside the percentage, matching the Screener grid: `+3.14 (+8.83%)` (green/red by sign, `—` when unknown). No business-logic changes — pure presentation.

## Shared helper (new)

Add `Return1DCell` to `src/components/hud/DataTable.tsx` (next to `PctCell`):

- Props: `{ abs: number | null | undefined; pct: number | null | undefined }`.
- Renders `+A.AA (+P.PP%)` when both known, falls back to whichever is available, `—` when neither. Uses `var(--ok)` / `var(--danger)` / `var(--text-dim)` by sign of pct (fallback: sign of abs). Uses the same minus glyph and `whiteSpace: nowrap` as the current Screener cell.
- When only abs is missing but `ltp` + `previous_close` (or `day_change`) are derivable at the callsite, callers may pass a computed abs. The helper itself does no derivation.

Also refactor Screener's inline cell (`src/routes/market/Screener.tsx` L658–678) to use `Return1DCell` so it stays the single source of truth.

## Callsites to update

Each callsite computes `abs` from data already at hand — no new fetches, no schema changes.

1. **Overview / Top Breakouts grid** — `src/lib/market/screenerColumns.tsx` `change_pct` column: replace `<PctCell value={row.original.change_pct}/>` with `<Return1DCell abs={row.original.change_abs} pct={row.original.change_pct}/>`. (`change_abs` already selected by `screenerRun.ts` and present in `market_screener_rows`.)
2. **Watchlist** — `src/components/market/WatchlistPanel.tsx` L251–256: use `Return1DCell` with `abs = q?.day_change ?? (q?.ltp && q?.previous_close ? q.ltp - q.previous_close : null)`, `pct = q?.change_pct`.
3. **Top Movers strip** — `src/components/market/TopMoversPanel.tsx` L46: same helper; derive abs from row (`day_change` / `ltp − prev_close` as available).
4. **Market Strip (indices)** — `src/components/market/MarketStrip.tsx` L44–75: extend the live/quote map with `change_abs`, feed into `Return1DCell`. Live-tick source already carries `ltp` + `change_pct`; derive abs from `ltp * pct / (100 + pct)` when `change_abs` isn't in the tick payload (same trick Screener uses at L664–665).
5. **Index Detail** — `src/routes/market/IndexDetail.tsx`:
   - Header (L66–67) already has both `chgPct` and `chgAbs` — ensure it renders in the unified `+A (+P%)` format.
   - Constituents table column (L383–384): extend `liveByKey` map to also carry `change_abs` (compute from live tick when missing), swap `PctCell` for `Return1DCell`.
6. **Positions table** — `src/routes/market/Positions.tsx` L192: column shows day-change %. Swap for `Return1DCell` fed with `quote.day_change`/derived abs and `quote.change_pct`.
7. **Breadth Details dialog** — `src/components/market/BreadthDetailsDialog.tsx` L85–87: swap the inline `%` span for `Return1DCell` (abs from `s.change_abs` if present in that row shape, else derived from `s.ltp` + `s.change_pct`; if abs isn't derivable there, the helper falls back to `+P.PP%`).
8. **Dashboard "Top Breakouts" table** — `src/routes/market/Dashboard.tsx` uses the shared `overviewColumnMap`, so it inherits the fix from #1. Verify the live-tick overlay at L219 carries `change_abs` too (add it, derived from tick's ltp + pct).
9. **Analysis header** — `src/routes/market/Analysis.tsx` L283: header currently shows `chgPct` only. Add abs from `quote.day_change` (or derived) and render in unified format.

## Not in scope

- No changes to filtering, sorting, freshness gating, DB views, or edge functions.
- Sort behavior stays keyed on `change_pct` (unchanged accessor).
- Portfolio Overview P&L cards already show ₹ + % — leave alone.

## Technical notes

- Sign source: use `pct` for color when present, else `abs`. Zero → dim. This matches Screener today.
- Formatting: `abs.toFixed(2)` with `+`/`−` (Unicode minus) prefix; `pct.toFixed(2)%` likewise; single `whiteSpace: nowrap` span, so column widths stay tight.
- No new DB columns needed — `change_abs` exists on `market_screener_rows`; `Quote.day_change` + `previous_close` cover the live paths.

## Verification

- Typecheck (`tsgo`) + `bunx vitest run` (existing tests unaffected).
- Playwright: load `/market` (Top Breakouts), `/market/screener`, `/market/positions`, `/market/holdings`, an index detail page, and a symbol Analysis page; screenshot each and confirm the `+abs (+pct%)` format renders with correct colors.
