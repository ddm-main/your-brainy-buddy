## What's actually wrong

Verified against the database and the fetch path — the chart is capped at ~2 years by four separate limits:

1. **Stored history is only 2 years.** `market_daily_prices` for NILKAMAL holds 503 NSE bars (2024-07-18 → 2026-07-27); SGMART 216. Every writer requests `"2y"`: `market-candles/index.ts:60` (`rows.length < 100 ? "2y" : "30d"`) and `market-history-backfill/index.ts:57` (`getOHLCV(..., "2y", "1d")`, with `DEFAULT_MIN_BARS = 260`). Nothing ever asks for more, so nothing deeper is ever stored.
2. **The 1D read is capped and reads the wrong end.** `market-candles/index.ts:41-45` does `.order("trade_date", ascending: true).limit(600)` — that returns the *oldest* 600 rows, so once a symbol exceeds 600 stored bars the chart silently drops the most recent ones and can never show more than ~2.4 years.
3. **Weekly/monthly never use Yahoo's deep history.** `1W` → `5y`, `1M` → `10y` (`market-candles/index.ts:23-24`) go straight to the provider. Kotak's `/charts/v2/history` returns whatever short window it has; the Yahoo fallback in `provider.ts:545-554` only triggers on an *empty* result, so a short-but-non-empty Kotak reply is served as-is. That is the 1M chart in the screenshot showing ~1 year of bars.
4. **No "max" range anywhere.** `rangeSec` in `provider.ts:522-529` tops out at `10y` and Yahoo is never asked for `range=max`, which is the only way to get a stock's full listed history.

## Fix

**Data depth (edge functions)**
- Add `"max"` to the Kotak `rangeSec` map (epoch 0 / listing date) and pass `range` through to Yahoo unchanged so `max` reaches `yahooChartRetry`.
- Chunk long Kotak daily requests into ≤2-year windows and concatenate + de-duplicate, since Kotak's history endpoint truncates long spans rather than erroring.
- `market-candles` 1D branch: request `"max"` (not `2y`) on first fill, and treat "we have < N years of history" as a refill trigger, not just `rows.length < 100`.
- `market-history-backfill`: fetch `"max"` instead of `2y`, raise `DEFAULT_MIN_BARS` so already-shallow symbols get re-deepened, and keep the existing chunked upsert.

**Read path**
- `market-candles` 1D: drop the oldest-600 cap — order descending with a generous limit (e.g. 10 000 rows, ~40 years), then reverse for the chart. Correctness fix independent of depth.
- Weekly/monthly: derive `1W`/`1M` by resampling the deep stored daily series when it is deeper than what the provider returns, instead of trusting a short provider reply. Fall back to the provider only when there is no stored history.
- Add a length sanity check: if the provider returns materially fewer bars than the requested range implies, retry via Yahoo `max` before returning.

**UI**
- `ChartToolbar.tsx`: the timeframe menu controls bar *grain* only; add a separate range/period control (1Y / 3Y / 5Y / All, default All) so the chart can zoom out to the full stored series, and pass it into `useCandles`/`market-candles`.
- `CandleChart.tsx`: keep the initial visible window sensible (last ~6 months of bars) while the full series remains loaded and scrollable to the left — TradingView behaviour.

**Backfill run**
- After deploying, invoke `market-history-backfill` repeatedly until `drained: true` so existing symbols get their full history written, then verify `min(trade_date)` per symbol in `market_daily_prices`.

## Technical details

- Files: `supabase/functions/market-candles/index.ts`, `supabase/functions/market-history-backfill/index.ts`, `supabase/functions/_shared/market/provider.ts`, `supabase/functions/_shared/market/yahooClient.ts`, `src/lib/market/hooks.ts`, `src/components/market/ChartToolbar.tsx`, `src/routes/market/Analysis.tsx`, `src/components/market/CandleChart.tsx`.
- No schema change needed — `market_daily_prices` is already keyed on `(symbol, exchange, trade_date)` and upserts are idempotent.
- Note: genuinely recent listings (SGMART listed 2025-09) will still show a short chart; that is correct, not a bug.
