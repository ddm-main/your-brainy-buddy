Background audit

I inspected the market tables, the `market_screener_rows` view, `market-nse-bhavcopy-sync`, `market-scrips-sync`, `market-fundamentals-global-sync`, `Screener.tsx`, and `screenerCatalog.ts`. The current filters are correct; the mismatch is caused by missing or stale data.

Key facts discovered
- `market_eod_nse` is empty (0 rows), so the screener has no authoritative NSE close/volume/change%.
- `market_shares_outstanding` is empty (0 rows), so the `market_screener_rows` strict market cap cannot be computed; it falls back to FMP-re-priced mcap.
- `market_nse_master` is empty (0 rows), so `fno_enabled` and `sme` flags are derived only from `market_stocks` and miss the official NSE series.
- `market_stocks` has only 2,705 active symbols. Tickertape covers ~4,000 because it includes all NSE EQ/BE/BZ/SM/SME series.
- `Screener.tsx` line 206 drops every row whose `trade_date` is not exactly `latestTradeDate`. This is stricter than the 3-day lag allowed in `screenerCatalog.ts` and silently removes valid symbols.
- `market_data` is referenced by `market-scrips-sync` and `market-fundamentals-global-sync` but does not exist in the schema; those upserts silently fail and are dead code.

What is already implemented
- `market_screener_rows` view is correct and will use NSE EOD + shares data once it exists.
- `market-pipeline-eod` builds technical indicators, but it sources from Yahoo and is not authoritative.
- `market-nse-bhavcopy-sync` exists but does not authenticate with NSEIndia; it returns 503/403.
- `market-scrips-sync` uses Kotak scrip master; without Kotak settings it only seeds NIFTY500.
- `MarketConfig.tsx` has manual resync buttons.

What is remaining
1. Fix NSE EOD ingestion (`market-nse-bhavcopy-sync`):
   - Authenticate against NSEIndia (homepage cookie + quote-equity warm-up) before downloading `BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip`.
   - Walk back up to 6 trade days for weekends/holidays.
   - Upsert into `market_eod_nse` and write a `market_ingestion_runs` summary.
2. Implement `market-nse-master-sync` edge function:
   - Download the official NSE equity master (`EQUITY_L.csv`) using the same authenticated session.
   - Upsert `market_nse_master` (symbol, isin, company_name, series, face_value, listing_date, is_active).
   - Expand `market_stocks` with all active NSE equity series (EQ, BE, BZ, SM, ST, SME).
3. Implement `market-shares-outstanding-sync` edge function:
   - Fetch `issuedSize` from NSE equity-details API per symbol (chunked, ~100 symbols/batch with concurrency).
   - Upsert `market_shares_outstanding` with `total_shares` and `source='nse'`.
   - Fall back to Yahoo `defaultKeyStatistics.sharesOutstanding` for any missing symbol.
4. Implement `market-fno-list-sync` edge function:
   - Download NSE F&O mktlots CSV (`https://archives.nseindia.com/content/fo/fo_mktlots.csv`).
   - Mark `fno_enabled=true` in `market_stocks` for those symbols.
5. Update screener freshness logic:
   - Remove the strict `r.trade_date === latestTradeDate` pre-filter in `Screener.tsx`.
   - Rely on `filterMatches` / `rowIsApplicable` which already honours the configured lag window.
   - Keep `TECH_FRESHNESS_LAG_DAYS = 0` or change to 3 days? The comment says 3 days covers Fri-Mon. The user wants parity with Tickertape which uses settled EOD; I will keep 0 for strict same-day parity but remove the redundant pre-filter, so stale rows are treated as missing data rather than silently dropped before coverage logic runs.
6. Clean up dead code:
   - Remove `market_data` upserts from `market-scrips-sync` and `market-fundamentals-global-sync` since the table does not exist.
7. Add cron schedules:
   - `market-nse-bhavcopy-sync` daily after market close.
   - `market-nse-master-sync` weekly.
   - `market-shares-outstanding-sync` weekly.
   - `market-fno-list-sync` weekly.
8. Verification:
   - Run unit tests (`vitest run`).
   - Trigger the new functions manually and confirm `market_eod_nse` and `market_shares_outstanding` rows appear.
   - Compare screener result counts for a standard Tickertape screen (e.g., `market_cap > 20,000 Cr`, `ROE > 15`).

Open questions / not in this plan
- I will not change the fundamental provider (Yahoo/FMP); I will only fix the data the screener already tries to use.
- I will not add new filter fields or presets; I will make the existing filters accurate.
- I will not add a premium data source unless the user explicitly asks for it.