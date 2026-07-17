
# Full Market Data Buildout on Kotak Neo (+ fundamentals via Yahoo)

Kotak Neo is now authenticated. It gives us **real trading-grade data** (quotes, candles, depth, option chain, orders, holdings, margins) but **not fundamentals** — those still come from Yahoo. Plan below covers everything reachable across both.

## What Kotak Neo actually exposes (source of truth for scope)

| Category | Endpoint(s) | We currently use? |
|---|---|---|
| Login / session refresh | `/login/1.0/tradeApiLogin`, `tradeApiValidate` | Yes |
| Holdings | `/portfolio/v1/holdings` | Yes |
| Positions | `/quick/user/positions` | Yes |
| Margins / limits | `/quick/user/limits` | Yes |
| LTP / OHLC quotes (batch) | `/quotes` | Yes |
| Historical candles (1m–1d, up to years) | `/charts/v2/history` | **No — using Yahoo** |
| Level-2 market depth | `/depth` | No |
| Option chain (strikes, greeks, OI) | `/optionchain` | No |
| Scrip master (instrument list) | `/masterscrip/file-paths` | Yes (sync) |
| Orders / trades / order book | `/orders`, `/trades` | No |
| Live streaming (WebSocket) | `wss://mlhsm.kotaksecurities.com` | No |

Fundamentals (P/E, EPS, sector, market cap, ratios, financials) are **not** in Kotak Neo — Yahoo `quoteSummary` fills that.

## Phase 1 — Kotak-native pricing (highest signal)

1. **Historical candles from Kotak** — new `_shared/market/kotakClient.ts::kotakCandles(symbol, exchange, from, to, interval)` hitting `/charts/v2/history`. Route `market-candles` through the active provider (Kotak first, Yahoo fallback) so charts on Analysis/Watchlist/Screener use the same feed as quotes.
2. **Market depth** — new edge function `market-depth` returning bid/ask ladder from `/depth`. Show a 5-level depth panel on `Analysis.tsx`.
3. **Option chain** — new edge function `market-option-chain` (`/optionchain`) + new route `src/routes/market/OptionChain.tsx` with expiry selector, strike ladder, OI change, IV, and greeks. Add to Market top-tabs.
4. **Live quotes stream** — Kotak Neo HSM WebSocket. New edge function `market-ws-token` mints the session token; a client hook `useKotakStream(symbols[])` subscribes and pushes tick updates into a Zustand slice consumed by Dashboard / Watchlist / Analysis.

## Phase 2 — Fundamentals & richer instrument profile

5. **Fundamentals via Yahoo `quoteSummary`** — new `market-fundamentals` edge function pulling `summaryDetail`, `defaultKeyStatistics`, `financialData`, `incomeStatementHistory`, `earnings`, `assetProfile`. Cache in a new `market_fundamentals` table (1-day TTL). Surface on Analysis: P/E, PEG, EPS TTM/fwd, ROE, margins, debt/equity, dividend yield, revenue/EPS growth, sector/industry, 52-week range, beta, shares outstanding.
6. **Corporate actions / earnings calendar** — reuse Yahoo `calendarEvents`; store next earnings date + last dividend on each stock row. Display on Watchlist and Analysis.
7. **News** — already have `market_news`; extend `market-morning-insight` to also pull per-symbol news via Yahoo `news` endpoint. Show on Analysis.

## Phase 3 — Screener & Analysis expansion

8. **Expand `market_stock_scores` / screener inputs** with the new fields: fundamentals (P/E, ROE, growth), Kotak-derived technicals from real candles (RSI, MACD, ADX, ATR, Bollinger, volume surge), option-flow signals (PCR, IV rank), and depth imbalance snapshot.
9. **Screener presets**: "High Growth Value", "Momentum Breakout" (real Kotak candles), "Oversold Quality", "Unusual Options Activity", "Delivery Volume Surge". Each is a saved `market_saved_screeners` row shipped seeded.
10. **Analysis page overhaul** — one page per symbol with: header (LTP, day range, 52w, market cap), Kotak candle chart with SMA/EMA/BB overlays, indicators table, fundamentals block, option-chain snapshot (ATM ±5), depth ladder, news list, holdings/positions if held.

## Phase 4 — Orders & broker actions (optional, ask before enabling)

11. Read-only `market-orders` / `market-trades` endpoints to show today's order book and executions on Positions. Order placement is intentionally excluded unless you explicitly ask — that's a separate risk conversation.

## Database changes

- `market_fundamentals` (user_id, symbol, exchange, payload jsonb, fetched_at) + RLS + GRANTs.
- Add columns to `market_stocks`: `sector`, `industry`, `market_cap`, `pe_ttm`, `roe`, `next_earnings_at`.
- Add `market_option_chain_snapshots` (symbol, expiry, captured_at, payload jsonb) with 7-day retention.
- Every new public table gets `GRANT` + RLS scoped to `auth.uid()`.

## Technical notes

- All new edge functions go through `_shared/market/provider.ts` so Kotak → Yahoo fallback is uniform and observable via `connection_status`.
- Rate-limit Kotak calls to the `rate_limit` already stored on `market_api_settings` (default 10 rps) using a small token bucket in `_shared/market/kotakClient.ts`.
- Cache: quotes 15s, depth 3s, option chain 30s, candles 5m, fundamentals 24h. Cache is per-user via existing `market_indicators_cache` or new dedicated tables where payload is large.
- No `service_role` key leaves the server; front-end continues to invoke via `supabase.functions.invoke` with the anon key.
- WebSocket lives in a single `useEffect` and cleans up with `supabase.removeChannel`/`ws.close`, per project rule.

## Recommended order

Phase 1 first (biggest visible upgrade: real Kotak charts + option chain + depth + live ticks). Phase 2 next (fundamentals — needed for a serious screener). Phase 3 to make the screener/analysis pages worth opening. Phase 4 only if you want it.

Confirm this scope (or trim — e.g. "skip WebSocket for now", "no option chain yet") and I'll start on Phase 1.
