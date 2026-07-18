# Fix stale/incorrect prices across Market

## Root cause

- `market_daily_prices` for NILKAMAL has 496 rows but latest is `2026-07-16` (Friday 07-17's close of ₹1473.50 was never cached). NILKAMAL is not in `market_stocks`, so the EOD pipeline never refreshes it.
- `market-candles` for `1D` only backfills when `rows.length < 100`. With 496 stale rows it skips the fetch and returns 2026-07-16's close (₹1341.10) — the value the Analysis chart displays.
- `market_holdings` has no `ltp` column; LTP is fetched live via `market-quotes`. NILKAMAL has no token in `market_stocks`, so `kotakProvider.getQuotes` routes it to Yahoo. If Yahoo returns null (rate limit / transient), the symbol is silently omitted → Holdings row shows `—` and computes P&L as 0.

## Changes

### 1. `supabase/functions/market-candles/index.ts` — always refresh stale 1D cache
Compute the most recent expected trading day (IST, Mon–Fri, using 16:00 IST as EOD cutoff). If the latest cached `trade_date` is older than that, fetch a short recent range (`30d`, interval `1d`) from the active provider (Kotak → Yahoo fallback) and merge the fresh bars into the returned series in addition to upserting to cache. Keep the existing `< 100 rows` full-backfill path.

### 2. `supabase/functions/market-quotes/index.ts` — quote retry + never-fail rows
- If Yahoo's per-symbol `fetchOne` returns null on first pass, retry once with a 400 ms delay (mitigates Yahoo's occasional 429s that made individual symbols disappear).
- If a symbol still has no live quote, fall back to the latest `market_daily_prices.close` and emit it with `source: "cache"` and `change_pct/day_change: null`. Prevents `—` LTP and 0-P&L for symbols outside the Kotak universe.

### 3. `supabase/functions/market-sync-holdings/index.ts` — prime `market_stocks` for user holdings
After syncing holdings from Kotak, upsert a stub row into `market_stocks` (symbol, exchange, token from Kotak's holding payload) for each holding so future quotes/candles use the Kotak fast path. Silently ignore rows that lack a token in Kotak's response.

### 4. `src/routes/market/Holdings.tsx` — surface cache/staleness
When a quote's `source === "cache"`, render the LTP with a small `stale` chip so it's visibly distinguished from live quotes, and colour the Today's P&L cell neutral (not green/red) since it's unknown.

## Verification

- Reload `/market/analysis/NILKAMAL` — chart's last candle date should equal 2026-07-17 with close ≈ ₹1473.50.
- Reload `/market/holdings` — NILKAMAL row LTP shows ₹1473.5, Current ≈ ₹1473.5 × qty, P&L ≈ +₹6.41 per share × qty.
- Verify by tailing `market-candles` and `market-quotes` edge function logs during the refresh.

## Out of scope

- Adding NILKAMAL (and other user holdings outside NIFTY500) to the nightly EOD pipeline universe — the sync-holdings prime above is the minimum viable fix; a full universe overhaul can follow in a later pass.
