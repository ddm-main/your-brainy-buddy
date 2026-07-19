## Verified diagnosis

I checked the current code and live database state. The screener problem is real at the data layer, not just UI.

- `market_stock_scores` has 508 rows with technicals populated.
- `market_fundamentals_global` has 0 rows, so every fundamentals filter has no usable data.
- `market_stocks` has 2,699 active NSE stocks, but only 501 are in the current pipeline universe and the Screener’s “All Stocks” is based on score rows, so it only shows ~508 scored symbols, not all stocks.
- Cron jobs exist for market sync, but recent scheduled HTTP calls are returning 403, so automatic sync is broken.
- There is no scheduled fundamentals sync job right now.
- `market_index_members` is partial, and the current index constituent function returns data but does not persist it, so Nifty/BankNifty/FinNifty universe filters can be incomplete.
- `market-fundamentals-global-sync` silently swallows upstream errors and still stamps `last_fundamentals_sync_at`, which hides why Yahoo/NSE failed and makes the queue look “done” even when no fundamentals were inserted.
- Market navigation still exposes several immature/secondary sections (`AI Analysis Engine`, `Backtesting`, `Trade Planner`) as first-class tabs, which makes the section feel unfinished.

## Goal

Make Market behave like a proper Tickertape/Screener-style workspace:

- “All Stocks” actually includes all known active NSE stocks.
- Fundamentals, technicals, sectors, index membership, filters, and presets are populated automatically.
- The user should not need to manually sync anything.
- Manual sync controls become diagnostics/admin fallback only.
- Unreliable/unfinished sections are removed from primary navigation or merged into the right workflow.

## Plan

### 1. Fix automatic scheduled sync first

- Repair the cron secret mismatch causing 403 responses.
- Harden `requireCronSecret` and `market_cron_call` so scheduled market jobs authenticate consistently.
- Add clear non-secret diagnostics when a cron call fails, without exposing secret values.
- Add or restore scheduled jobs for:
  - universe/scrip master sync
  - index constituent persistence
  - EOD technical pipeline
  - sector/breadth aggregates
  - global fundamentals sync

### 2. Make fundamentals sync reliable and observable

Refactor `market-fundamentals-global-sync` so failures are visible and recoverable:

- Stop silently swallowing all Yahoo/NSE failures.
- Track per-symbol source status: `ok`, `partial`, `failed`, `last_error`, `source`, `data_as_of`.
- Only mark rows as successfully refreshed when at least useful metadata/fundamental fields are returned.
- Keep failed symbols retryable with backoff instead of hiding them for 7 days.
- Add fallback source order:
  1. Yahoo quoteSummary for ratios and financial fields.
  2. NSE public quote/meta endpoints for sector, industry, market cap, traded price metadata where Yahoo is missing.
  3. Existing NSE index CSVs for index membership and sector/industry fallback.
  4. Optional future paid/freemium providers only if you choose to add keys later.

I will not scrape Tickertape/Screener as a backend dependency; the app can match their UX, but relying on their pages as a data source is brittle and likely against usage terms.

### 3. Make “All Stocks” truly all active stocks

- Change the screener data model so `market_stocks` is the base dataset, not `market_stock_scores`.
- Left-join technical scores and fundamentals onto all active NSE stocks.
- Add a secure `market_screener_rows` read view or equivalent query layer so the frontend can load complete rows efficiently.
- Result: stocks without technicals/fundamentals still appear, with missing fields shown as `—`; filters on missing fields exclude those rows only when the user activates that filter.

### 4. Fix universes and index membership

- Persist official index constituents into `market_index_members` for at least:
  - Nifty 50
  - Nifty Next 50
  - Nifty 100/200/500
  - Bank Nifty
  - Fin Nifty
  - Midcap 100
  - Smallcap 100
- Update the screener universe logic to use the persisted membership reliably.
- Keep “All Stocks” separate from “Nifty 500” so the counts are clear.

### 5. Fix filter correctness and screener UX

- Rework filter coverage so each filter shows:
  - available data count
  - matched count
  - missing data count
  - last sync freshness
- Disable or clearly mark fundamentals presets until fundamentals coverage is usable.
- Add missing technical columns/filters that are already computed but not fully exposed:
  - EMA 20/50/100/200
  - MACD / signal / histogram
  - ATR / ATR %
  - support/resistance
  - 52-week high/low
  - relative strength
- Add missing fundamentals display where available:
  - market cap
  - PE/PB/PEG
  - EPS/book value
  - ROE/ROCE
  - debt/equity
  - current/quick ratio
  - revenue/profit growth
  - promoter/institutional holding
- Remove filters/columns that have no dependable source yet, or mark them as “coming later” outside the main screener.

### 6. Replace manual sync UI with auto-sync health

- Remove prominent “Sync fundamentals / EOD batch / Aggregates” buttons from Screener and Dashboard.
- Replace with a compact “Data Health” strip showing:
  - total active stocks
  - technical coverage
  - fundamentals coverage
  - latest EOD date
  - latest fundamentals refresh
  - background sync status
- Keep manual run buttons only inside Market Settings under an “Advanced / Repair data” area.

### 7. Rearrange Market navigation

Simplify the primary Market tabs to:

```text
Overview | Screener | Analysis | Portfolio | Watchlists & Alerts | Settings
```

- Merge AI verdicts into `Analysis` instead of a separate `AI Analysis Engine` tab.
- Move `Trade Planner` into Analysis/Portfolio as a contextual tool, not a top-level section.
- Hide `Backtesting` from primary navigation until the data layer is reliable; keep code if useful, but do not present it as production-ready.
- Keep `Options` as a sub-tool under Analysis only when the selected symbol is F&O-enabled.

### 8. Update source comparison behavior

- Use Yahoo primarily for charts/technicals because it is free and already integrated.
- Add NSE fallback for Indian-market metadata and index membership.
- Treat free/freemium APIs as optional future integrations:
  - FMP/EODHD/Twelve Data can improve fundamentals but require API keys and have free-tier limits.
  - Alpha Vantage is not reliable enough for broad NSE fundamentals.
  - Unofficial NSE libraries are useful as implementation references, but direct controlled fetches are better for Edge Functions.

### 9. Verification

After implementation:

- Confirm cron calls stop returning 403.
- Confirm `market_fundamentals_global` populates non-zero rows.
- Confirm `market_stocks` active count remains ~2,699 and Screener “All Stocks” reflects that base universe.
- Confirm Nifty 50/Bank Nifty/Fin Nifty counts are populated from persisted index members.
- Confirm fundamentals filters like Market Cap, PE, ROE, Debt/Equity return non-zero matches where data exists.
- Confirm technical filters still work across scored symbols.
- Verify Market navigation is simplified and no unfinished section is exposed as a main tab.

## Files/areas to change after approval

- Supabase migration: sync state fields/view/index membership cron jobs.
- `supabase/functions/_shared/market/cron.ts`
- `supabase/functions/market-fundamentals-global-sync/index.ts`
- new or updated NSE fallback helper under `supabase/functions/_shared/market/`
- `supabase/functions/market-scrips-sync/index.ts`
- `supabase/functions/market-index-constituents/index.ts` or new persistent sync function
- `src/lib/market/screenerRun.ts`
- `src/lib/market/screenerCatalog.ts`
- `src/routes/market/Screener.tsx`
- `src/routes/market/Settings.tsx`
- `src/routes/Market.tsx`
- `src/routes/market/Analysis.tsx`

## Out of scope for this pass

- Paid market-data providers unless you explicitly approve adding an API key.
- Brokerage order placement changes.
- Scraping Tickertape/Screener pages as a production data source.