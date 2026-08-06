# Penny-stock purge — finish the job (the screener still shows penny names)

The purge itself is already live. What's broken is the last mile: the screener reads a frozen snapshot, so all 1,203 penny names are still on screen.

## Verified current state

- `market_stocks` has `penny_excluded`, `penny_reason`, `penny_checked_at`.
- A BEFORE INSERT/UPDATE trigger (`market_stocks_enforce_penny_exclusion`) re-asserts `in_universe = false` for flagged rows, so the NSE-master / scrips / bhavcopy / index-constituents jobs cannot re-admit them. Zero leaks right now (`penny_excluded AND in_universe` = 0).
- `market-penny-sweep` exists, is cron-gated, and is scheduled weekly (`15 4 * * 6`, active).
- The first sweep ran against 2026-08-05: 2,837 evaluated, **1,209 excluded**, 0 reinstated. Universe is now 1,620.
- The run finished with status `partial`, not `ok`, because the snapshot refresh failed:
  `infinite recursion detected in rules for relation "market_screener_live"`.
- Consequence: `market_screener_snapshot` still holds 2,837 rows, **1,203 of them penny-flagged**, and `market_screener_rows` (what the app queries) reads from that snapshot. So the purge is invisible in the UI.

## Root cause of the recursion

The 2026-08-05 view patch rebuilt `market_screener_live` by string-editing `pg_get_viewdef(...)` and re-issuing `CREATE OR REPLACE VIEW`. The resulting definition ends in `FROM market_screener_live v` — the view now selects from itself. Any read of it, including `refresh_market_screener_snapshot()`, errors out. Nothing has refreshed the snapshot since.

## The fix

1. **Rebuild `market_screener_live` from a real definition**, not from its own `viewdef`: take the full known-good body from the `2026-07-29` migration and re-apply, in explicit SQL, the three changes that patch intended:
   - latest-score lookup as a `LEFT JOIN LATERAL (... ORDER BY trade_date DESC LIMIT 1) sc`, dropping the `sc_any` join,
   - `vol_gt_avg30` as a nullable `CASE` (NULL when volume or `vol_avg30` is missing) instead of a false-when-unknown boolean,
   - `score_trade_date` sourced from `sc.trade_date`,
   - keep `breakout_score_v4` exposure that the later patch added.
2. **Exclude penny names at the source**: the view gets `WHERE NOT COALESCE(s.penny_excluded, false)`, so every downstream surface (screener, breakout, scoring inputs, AI recommendations) narrows to the non-penny universe without touching client code.
3. **Verify shape before committing**: assert the rebuilt view's column list and order still match `market_screener_snapshot` (the refresh does `INSERT ... SELECT *`), so the refresh can't fail on a shape mismatch.
4. **Refresh and re-run**: call `refresh_market_screener_snapshot()` (expect ~1,620 rows, 0 penny), then invoke `market-penny-sweep` once so a run lands with status `ok` and a real `snapshot_rows` count.

## Guardrail

`refresh_market_screener_snapshot()` currently swallows nothing but the sweep records the failure only inside metadata. Add a lightweight check to the sweep: if the refresh errors, the ingestion run is written with status `error` (not `partial`) so a broken snapshot surfaces in Config → Database & Storage instead of hiding in a JSON field.

## Technical notes

- No client/UI changes. `src/routes/market/Screener.tsx` already has its own liquidity-floor toggle; that stays as-is and now operates on an already-purged universe.
- Thresholds unchanged: `market_cap < 1000` (₹ crore) OR settled `close < 50`; NULL market cap is judged on price only.
- Reinstatement path is already symmetric in the sweep — nothing to add there.
- Work: one migration (view rebuild + penny filter + shape assertion + refresh), a small edit to `supabase/functions/market-penny-sweep/index.ts` for the error status, then one sweep invocation.
