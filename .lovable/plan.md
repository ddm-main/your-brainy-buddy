## Diagnosis (verified against the database)

- `market_stock_scores`: **508 rows** — technicals are fine.
- `market_fundamentals_global`: **0 rows** — completely empty.
- `market_stocks.market_cap`: **0/2699 populated**.
- `market_stocks WHERE is_active AND in_universe`: **501 rows**.

So every fundamentals-based filter (Market Cap, PE, ROE, D/E, growth, sector, industry…) matches nothing, which is exactly what the screenshot shows ("FUNDAMENTALS 0/508 · 0%", "0 OF 508"). Technicals-only filters still work.

Why the table is empty: `market-fundamentals-global-sync` tries to sync all 501 in-universe stocks in one invocation with ~250 ms sleep + up-to-8 s Yahoo timeout per stock. Supabase edge functions cap wall time well below the 12-minute budget the function assumes, so every manual "Sync fundamentals" click hits the ceiling before writing anything meaningful, and the table stays at zero.

## Fix plan

### 1. Make `market-fundamentals-global-sync` chunked + resumable

- Add a nullable cursor column `last_fundamentals_sync_at timestamptz` on `market_stocks` (migration).
- Rewrite the edge function to:
  - Select up to `CHUNK = 40` stocks where `in_universe AND is_active AND (last_fundamentals_sync_at IS NULL OR last_fundamentals_sync_at < now() - interval '7 days')`, ordered nulls-first, oldest-first.
  - Process them with `CONCURRENCY = 4` (Promise pool), no artificial sleep, 6 s Yahoo timeout.
  - Always stamp `last_fundamentals_sync_at = now()` even on failure (so one bad symbol can't wedge the queue), matching the `market-pipeline-eod` pattern.
  - Return `{ ok, processed, synced, failed, drained: processed < CHUNK }`.
- Keep the existing backfill of `market_stocks.market_cap/sector/industry`.

### 2. Auto-drain from the UI

- In `Screener.tsx` `DataHealthStrip.trigger("market-fundamentals-global-sync", …)`, loop invocations until the response says `drained: true` or `MAX_CALLS = 20`, updating the toast with `processed / total`.
- Invalidate the `["market", "screener-rows-v2", universe]` query on completion so rows re-fetch without a manual reload.

### 3. Guard fundamentals filters when coverage is zero

In `Screener.tsx`, when the user activates a filter whose `coverageOf(rows, id).has === 0`:
- Show an inline hint on the active filter chip: "No data yet — run Sync fundamentals".
- Highlight the Sync fundamentals button (pulse border) so the fix is one click away.

No change to `filterMatches` semantics — a null value should still exclude a row; this is just user-visible guidance.

### 4. Verify

- Trigger the sync from Settings once the migration + function are deployed; wait for `drained: true`.
- Re-run: `SELECT COUNT(*) FROM market_fundamentals_global WHERE market_cap_cr IS NOT NULL;` — expect ≈ 480+.
- Reload Screener → All Stocks → Market Cap 5,000–20,000 Cr → non-zero results, Fundamentals coverage ≥ 90 %.

## Files touched

- `supabase/migrations/<ts>_market_stocks_fundamentals_cursor.sql` — add `last_fundamentals_sync_at` + index.
- `supabase/functions/market-fundamentals-global-sync/index.ts` — chunked/resumable rewrite.
- `src/routes/market/Screener.tsx` — auto-drain loop, zero-coverage hint on active filter chips.

## Out of scope (call out only)

- `market_index_members` only has 77 rows; NIFTY50/BANKNIFTY/FINNIFTY universes will be partial until `market-index-constituents` is re-run. Not needed for the reported "All Stocks + Market Cap" bug — flag it, don't fix it in this batch unless you say so.
