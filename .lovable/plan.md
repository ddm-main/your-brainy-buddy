## Goal
Bring the JARVIS screener as close as technically possible to Tickertape parity, with no silent fallbacks, no stale values presented as fresh, and audit visibility for every mismatch.

## Confirmed from the current app/database
- `market_screener_rows` currently calculates market cap from:
  1. latest `market_shares_outstanding.total_shares × NSE close`,
  2. else `market_stock_scores.close`,
  3. else repriced provider market cap using `fundamentals market_cap × current close / fundamentals price`,
  4. else raw fundamentals/stocks market cap.
- For the screenshot symbols:
  - `BBL` and `DPABHUSHAN` use `shares_x_nse_close` from Yahoo share counts.
  - `TEGA`, `SHILCTECH`, and `ZOTA` have no row in `market_shares_outstanding`, so the view falls back to `fmp_repriced`.
  - `market_value_audit` has no stored Tickertape comparison rows for these symbols, so parity is not being continuously validated for the reported mismatch set.
- `market-data-validation` is pointed at legacy `market_data`, not the active `market_screener_rows` pipeline, so it is not validating the actual numbers shown in the screener.

## Required improvements

### 1. DB-first: add a provider observation + consensus layer
Create durable tables for normalized provider values instead of overwriting one canonical field blindly:

- `market_provider_observations`
  - symbol, exchange, metric, provider, value, provider_as_of, fetched_at, confidence, raw_payload_hash, raw_payload
  - Stores every observed value for market cap, shares outstanding, price, PE, PB, ROE, ROCE, debt/equity, EPS, book value, 52w high/low, volume, returns, etc.
- `market_metric_consensus`
  - symbol, exchange, metric, value, source_provider, source_method, confidence, ref_value, delta_pct, status, computed_at
  - The single audited value the UI should use.
- `market_reference_audit_runs`
  - batch/run metadata for Tickertape parity checks.
- Extend `market_value_audit`
  - add run id, provider value source, status buckets, threshold, and remediation notes if missing.

Access rules:
- Public/authenticated read only for final screener-safe values.
- Provider raw payloads service-role only, because they may contain unneeded upstream metadata.
- Edge functions write through service role only.

### 2. Fix market cap as the top-priority metric
Market cap should not be guessed from stale or incomplete inputs.

New precedence:
1. Tickertape reference market cap when available from the public info endpoint.
2. If Tickertape is unavailable, compute `latest accepted shares outstanding × latest exchange close` only when both inputs are fresh and provider confidence passes validation.
3. If share count is missing/stale, use the best provider-reported market cap, but mark it `estimated_provider` and expose lower confidence.
4. Never silently reprice old fundamentals without recording the method and age.

Specific fixes:
- Backfill shares outstanding for symbols currently missing (`TEGA`, `SHILCTECH`, `ZOTA`, etc.).
- Add validation that flags share-count drift causing market-cap deltas above tolerance.
- Store both `reported_market_cap` and `computed_market_cap` so we can see why a number differs.
- Update `market_screener_rows` to read from `market_metric_consensus` for market cap first, with transparent fallback metadata.

### 3. Add more free fallback sources
Use a waterfall and record every attempt:

- Tickertape public stock info endpoint as the reference comparator/source for parity fields.
- Yahoo quoteSummary and chart APIs.
- NSE bhavcopy / equity quote endpoints for close, volume, issued size where available.
- BSE bhavcopy for combined volume where available.
- Financial Modeling Prep if configured and still free within quota.
- Screener.in-compatible public pages only if accessible without credentials and parsed conservatively.

No source should overwrite canonical values directly; each writes observations, then consensus chooses the best accepted value.

### 4. Rebuild fundamentals sync around metric-level freshness
Update `market-fundamentals-global-sync` so it writes source/as-of fields for every metric, not just a few columns.

Metrics to validate and sync:
- Market cap
- PE / EPS
- PB / book value
- ROE / ROCE
- Debt/equity
- Revenue, profit, sales growth, profit growth, EPS growth
- Dividend yield
- Promoter, FII, DII, institutional holding
- 52w high/low

Rules:
- No null-to-zero unless the metric explicitly supports it.
- No Yahoo institutional value reused as DII.
- No ROCE proxy from ROA shown as actual ROCE unless labeled as proxy or excluded from parity mode.
- Every metric gets `source`, `as_of`, `confidence`, and `status`.

### 5. Rebuild technical parity checks
Keep EOD technicals deterministic and aligned to the same date as the screener reference.

Actions:
- Ensure close, previous close, 1D return, volume, and 52w values use the same trade date.
- Validate NSE+BSE combined volume vs Tickertape where possible.
- Keep RSI, ADX, MACD, EMA, ATR, Bollinger values from local candles, but add date/coverage warnings if candle data is stale.
- Prevent stale rows from passing technical filters.

### 6. Replace the current validation function
Rewrite `market-data-validation` to validate the active pipeline, not legacy `market_data`.

New validation output:
- invalid market cap
- stale price/fundamental/technical rows
- market cap delta vs Tickertape
- PE mismatch vs price/EPS
- PB mismatch vs price/book value
- missing shares outstanding
- source coverage per provider
- top mismatches by severity

It should not auto-mutates values unless the fix is deterministic and source-backed.

### 7. Add a “parity refresh” edge function
Add an authenticated/manual + cron-safe function:

- Input: symbols or full universe batch.
- Fetch provider observations.
- Compute consensus values.
- Write audit rows.
- Return mismatch summary.

This lets us recheck a single stock or run full-universe validation without waiting for the daily pipeline.

### 8. Update the screener UI for trust and debugging
In the app:
- Show parity/source status in the screener header.
- Add a “Refresh parity” action for selected/current filters.
- Add a compact per-row source indicator for market cap and key metrics.
- Add a data-quality panel showing mismatched symbols and stale metrics.
- Keep filters using the same values displayed in the table.

### 9. Backfill and verify
Execution order:
1. Run DB migration.
2. Deploy updated edge functions.
3. Run backfill for the reported symbols first.
4. Run backfill for the full active NSE universe in chunks.
5. Run parity audit against Tickertape sample/full universe.
6. Open the app, apply the same Market Cap + Price filters, and visually verify the result list and market-cap values.

### 10. Acceptance criteria
- Screenshot sample symbols show market cap matching Tickertape within display rounding where Tickertape data is available.
- No row uses `fmp_repriced` or guessed market cap without visible lower-confidence metadata.
- Missing source data is shown as missing/stale, not silently treated as accurate.
- Fundamental and technical filters use the same values displayed in the screener table.
- Audit tables show the mismatch rate and exact deltas for all checked symbols.

## Files/functions to change
- Database migration for observation/consensus/audit tables and updated `market_screener_rows` view.
- `supabase/functions/market-value-audit/index.ts`
- `supabase/functions/market-fundamentals-global-sync/index.ts`
- `supabase/functions/market-shares-outstanding-sync/index.ts`
- `supabase/functions/market-data-validation/index.ts`
- New `supabase/functions/market-parity-refresh/index.ts`
- `src/lib/market/screenerRun.ts`
- `src/routes/market/Screener.tsx`

## Important limitation
Exact Tickertape parity is only guaranteed for fields Tickertape’s public endpoints expose reliably at fetch time. For metrics not exposed or blocked, JARVIS will use a documented consensus value and mark it as lower-confidence instead of pretending it is exact.