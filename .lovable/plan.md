## Root cause (verified against DB)

Our screener's "tech" filter scope (Volume, 1D Return, RSI, Breakout, etc.) requires each row's `trade_date` to equal the freshest date in the loaded set. On the DB right now:

- 2,703 active EQ rows total
- Only **1,480 rows** carry today's trade_date (2026-07-22)
- **1,223 rows** are stuck on 2026-07-21 or earlier because `market-pipeline-eod` advances a symbol's sync cursor even when its Yahoo fetch returns nothing that day (documented in `screenerCatalog.ts:31-38`)

For the filters in the screenshot (mcap 1000-10000, price 100-1000, volume 100k-10M, 1D return 5-10%) the DB actually contains **16** matching rows. Our UI drops 6 of them — WEWORK, LOTUSDEV, KISSHT (=OnEMI), ASHIANA, EXICOM, VERANDA — purely because their `trade_date` is 2026-07-21, not 2026-07-22. Tickertape shows all 16 (plus 2 not in our universe: WATERWAYS, INDIQUBE — those are separate coverage gaps to fix later).

## What to change

**One targeted fix in `src/lib/market/screenerCatalog.ts`.** Relax the tech-scope freshness gate so a row is considered "fresh enough" when its `trade_date` is within a small window of the latest (default: 3 trading-days). The doc comments and rationale that motivate the strict check will be preserved and updated to explain the new tolerance.

Concretely, in `rowIsApplicable`:

```ts
case "tech":
  if (row.trade_date == null) return false;
  if (latestTradeDate != null) {
    const lagDays = Math.round(
      (Date.parse(`${latestTradeDate}T00:00:00Z`) - Date.parse(`${row.trade_date}T00:00:00Z`)) / 86_400_000
    );
    if (lagDays < 0 || lagDays > 3) return false;
  }
  return true;
```

This keeps stale-forever rows out (the original concern) while accepting rows that are 1-3 days behind — which matches how Tickertape/Screener.in treat EOD data. The `DataHealthStrip` "stale rows" indicator already surfaces the discrepancy visually, so users still see when a symbol is behind.

Applied to the current DB, the same filters will return 16 matches instead of 10.

## Not in scope for this change

- **Universe coverage gap** (WATERWAYS, INDIQUBE etc. missing entirely): separate problem in `market-scrips-sync` / SME onboarding; will report but not fix in this pass unless you want it bundled.
- **Pipeline staleness itself** (1,223 rows on old dates): a symptom of `market-pipeline-eod` cursor advancement on empty fetches — a deeper edge-function fix; would be a follow-up.

## Verification

- Re-run the same 4 filters in the UI — expect 16 results, matching the DB query.
- Existing unit tests: `tests/screenerFilters.test.ts` covers scope behavior; will update/add a case for the new lag tolerance.
- `tsgo` runs automatically after edits.
