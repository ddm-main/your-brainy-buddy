# Clean universe: pennies deleted, ETFs and SME out, monthly rescan only

Rule unchanged: penny = market cap < ₹1,000 Cr **or** last close < ₹50.

## Verified current state

- `market_stocks` holds 3,305 rows: 1,652 active + clean (`in_universe = true`), 1,141 active + penny-flagged, 512 inactive. `in_universe` is **not** false everywhere — it is true on exactly the 1,652 clean names; the 1,653 false rows are the penny and inactive ones.
- The earlier purge worked: **zero** penny rows remain in the 15 derived tables checked (daily prices, EOD, indicators, fundamentals, scores, snapshot, nse_master, score history, live prices, shares outstanding, intraday, news, breakout, AI, quotes).
- Monthly crons are already in place: `market-scrips-sync` 02:00 and `market-penny-sweep` 02:30 on the 1st.
- The 271 no-cap names in the universe are not a data-fetch failure. They break down as ~50 ETFs (BANKBEES, CASHIETF, AUTOBEES…), 73 SME-platform scrips (series SM/ST), 12 series-BE scrips, and the remainder EQ names where Yahoo returns `ok` but carries no cap. ETFs and SME scrips have no market cap by nature — no sync will ever produce one.
- `market_penny_sweep()` leaves the flag **unchanged** when cap or price is unknown, and sets `in_universe = is_active AND NOT penny`. That is the leak: a newly listed no-cap name enters the universe and stays.
- Penny filtering exists in 6 jobs (`penny_excluded = false`), but no job filters on `in_universe`, series, or instrument class — so ETFs and SME scrips still consume the 15-minute fundamentals queue and the history backfill.
- `market_nse_master` has 1,420 rows against a 1,652-name universe; `market_daily_prices` holds 1,769 distinct symbols, ~117 of them outside the universe.

## The plan

### 1. Delete penny and inactive rows, permanently

- New `market_excluded_symbols` table (symbol, exchange, reason, excluded_at): a permanent blocklist so a deleted name is never re-added.
- Insert all 1,141 penny + 512 inactive symbols into it, then delete those rows from `market_stocks`. Their derived data is already purged; any stragglers (e.g. the ~117 orphan price symbols) are cleared in the same pass.
- `market-scrips-sync`, `market-nse-master-sync`, `market-bse-bhavcopy-sync` and `market-index-constituents` skip any symbol in the blocklist, so the monthly listing refresh cannot re-create them.
- The monthly penny scan evaluates only live universe members; blocklisted names are never re-scanned or reinstated. Removing a name from the blocklist is a deliberate manual act.

### 2. ETFs and SME scrips leave the universe

- Classify at ingest: series `SM`, `ST`, `BE`, `BZ` and ETF/fund instruments (symbol/name pattern plus NSE series) are marked non-equity and never enter the tradable universe.
- Existing such rows go to the blocklist with reason `sme` / `etf` / `series` and are deleted along with the pennies.
- After this, market cap is genuinely required on every remaining name.

### 3. Make missing market cap an error, not a silent state

- The sweep stops leaving unknown-cap names alone: a universe member with no cap after two sync attempts is blocklisted with reason `no_market_cap`.
- Add a fallback cap derivation — shares outstanding × last close — before declaring a name capless, so a Yahoo gap alone doesn't evict a real company.
- Add a daily data-validation check that reports any in-universe row with a null cap; expected value after this work is zero.

### 4. `in_universe` becomes the single gate

- With pennies and non-equities deleted, `market_stocks` contains only the valid universe and `in_universe = is_active` on every row.
- All symbol-reading jobs switch their filter from `penny_excluded = false` to `in_universe = true`: fundamentals-global-sync, history-backfill, live-sweep universe, news-sync, shares-outstanding-sync, score-evaluate, daily-sync, pipeline-aggregates. Fewer symbols fetched means less egress on every run.
- `market_nse_master` is reconciled to the universe so search and autocomplete offer nothing outside it.

### 5. Monthly-only listing refresh

- `market-scrips-sync` (02:00) then `market-penny-sweep` (02:30) on the 1st stay as the only add/remove path — verified already scheduled. No other job may insert into `market_stocks`; the ingest guard enforces it.
- Each monthly run writes a summary (added, removed, blocklisted, universe size) to the maintenance log so drift is visible.

## Technical notes

- One migration: `market_excluded_symbols` (+ grants, RLS, service-role access), rewritten `market_penny_sweep()` with delete-and-blocklist semantics and the cap fallback, an updated `enforce_penny_exclusion` / insert guard that rejects blocklisted and non-equity symbols, plus the supporting index.
- One batched data operation for the blocklist backfill, row deletion and orphan cleanup, followed by a screener-snapshot and score-distribution refresh.
- Edge-function edits: universe filter swap across the eight readers, blocklist filter in the four ingest jobs, series/ETF classification in `market-scrips-sync`.
- Verification after the run: `market_stocks` count equals the clean universe, zero null caps in-universe, zero rows in derived tables for any blocklisted symbol, screener/breakout surfaces return no excluded name, and the monthly cron summary reports a stable universe size.
