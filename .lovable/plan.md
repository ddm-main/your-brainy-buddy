## Findings confirmed

- **Holdings UI is mathematically using different bases**:
  - Total P&L = `(LTP - average buy price) × quantity`.
  - Today’s P&L = `provider day_change × quantity`.
- For NILKAMAL, database currently has:
  - Average buy: `₹1467.0872`
  - LTP shown: `₹1473.50`
  - Total P&L: about `₹6.41`
  - Cached previous daily close: `₹1341.10` from `market_daily_prices`, dated `2026-07-16`
- That means Today’s P&L is being calculated against an incorrect/stale previous close path, which makes it larger than total P&L.
- The same quote `day_change` value is reused in **Holdings**, **Market Dashboard**, and **Positions**, so this is not just a display bug.

## Plan

1. **Create one shared P&L calculation model**
   - Add a market P&L utility used by Holdings, Dashboard, and Positions.
   - Standardize:
     - `invested = avg/entry price × quantity`
     - `current = LTP × quantity`
     - `totalPnl = current - invested`
     - `todayPnl = (LTP - reliable previous close) × quantity`
   - Prevent invalid states like stale/missing day-change producing misleading values.

2. **Fix quote payload quality at the edge function**
   - Update `market-quotes` to return:
     - `ltp`
     - `previous_close`
     - `day_change`
     - `change_pct`
     - `source`
     - `stale` / `as_of` metadata when using cache.
   - Do not expose `day_change` when the provider cannot supply a reliable previous close.
   - For cache fallback, return LTP only unless a real prior close is known from fresh daily data.

3. **Fix Kotak quote normalization**
   - Deepen parsing of Kotak quote fields because `close`, `prevClose`, and LTP field names vary by endpoint.
   - Ignore zero/empty previous-close values.
   - Add guardrails so a bad previous close cannot create impossible Today’s P&L.

4. **Fix Yahoo previous-close derivation**
   - Use exchange-local trading day logic for Indian symbols instead of UTC-only date comparison.
   - Prefer the latest completed prior trading session from the chart bars.
   - If Yahoo returns stale previous close, mark day change unavailable instead of using it blindly.

5. **Update Holdings UI**
   - Show Today as `—` when previous close is unavailable/untrusted.
   - Add a compact source/stale indicator so Deepak can tell whether LTP came from Kotak, Yahoo, or cache.
   - Recalculate summary totals only from trusted rows.

6. **Update Dashboard and Positions**
   - Replace their duplicated day-P&L math with the shared utility.
   - Ensure Dashboard portfolio pulse and Positions “Today” match Holdings.

7. **Validate with the NILKAMAL case**
   - Expected after fix:
     - LTP around `₹1473.50`
     - Total P&L around `₹6.41`
     - Today’s P&L is either based on a verified previous close or shown as unavailable, never falsely `₹132.4` from stale `₹1341.10`.

## Technical files to change

- `supabase/functions/market-quotes/index.ts`
- `supabase/functions/_shared/market/provider.ts`
- `supabase/functions/_shared/market/yahooClient.ts`
- `src/routes/market/Holdings.tsx`
- `src/routes/market/Dashboard.tsx`
- `src/routes/market/Positions.tsx`
- New shared frontend helper under `src/lib/market/` for quote/P&L normalization

## Verification

- Deploy/test the updated `market-quotes` function.
- Query/call the NILKAMAL quote path and confirm stale `₹1341.10` is not used for Today’s P&L.
- Verify Holdings, Dashboard, and Positions all show consistent P&L values.