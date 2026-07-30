# Add Shoonya (Finvasia Noren) as a full broker + data provider

Shoonya joins Kotak Neo as a second connectable broker: quotes, depth, **real candles**, funds, holdings, positions, orders, plus live WebSocket streaming. Kotak stays exactly as it is; you choose which broker is active per account and which one feeds market data.

The big win: Shoonya's Noren API does publish historical candles (`TPSeries` intraday, `EODChartData` daily). That removes the "broker has no candles API — history: yahoo/cache" fallback sitting on every chart today.

## What you get

- A **Shoonya** card in Config -> Providers with its own feed list, probes and freshness, next to Kotak Neo / Yahoo / FMP / Alpha Vantage / NSE / BSE.
- A **Shoonya** option in the broker connect panel (Market -> Settings): connect, unattended TOTP auto-login, session status, test, disconnect.
- Charts, screener, watchlists, holdings, positions, orders, funds and auto-trade all able to run off Shoonya.
- Live streaming ticks and depth from Shoonya's WebSocket through the existing relay.

## Credentials

All six Shoonya secrets are already stored in the backend (`SHOONYA_USER_ID`, `SHOONYA_PASSWORD`, `SHOONYA_VENDOR_CODE`, `SHOONYA_API_SECRET`, `SHOONYA_TOTP_SEED`, `SHOONYA_IMEI`), so nothing new needs pasting. Client ID `FA207868_U` is the vendor code; the secret code you pasted in chat is the API secret — because it appeared in plain chat, rotate it in Shoonya's Api Key Generation screen after this ships and re-save it.

Per-user connections keep their own encrypted copy in `market_api_settings` (same AES-GCM scheme as Kotak), so the app is not tied to one hardcoded login; the env secrets act as the system-feed account.

## Phases

**Phase 1 — Auth + session (foundation)**
- Migration: add `'shoonya'` to the `market_provider` enum; add `shoonya_token` to `market_stocks` (Noren tokens differ from Kotak's) and the extra credential columns Shoonya needs on `market_api_settings` (vendor code, encrypted API secret, encrypted password).
- `_shared/market/shoonyaClient.ts`: `QuickAuth` login (`pwd` = SHA-256 of password, `appkey` = SHA-256 of `uid|api_secret`, `factor2` = TOTP from the stored seed), `susertoken` persisted encrypted, auto-relogin on session expiry, `Logout`.
- Edge functions `market-shoonya-login` and `market-shoonya-probe`, mirroring the Kotak ones.
- Error classifier for Noren `stat: "Not_Ok"` + `emsg` responses.

**Phase 2 — Symbol master + quotes/depth**
- Scrip-master sync from `https://api.shoonya.com/{NSE,BSE}_symbols.txt.zip` into `market_stocks.shoonya_token`, on the nightly cron slot next to the NSE master sync.
- `GetQuotes` -> `QuoteRow` and quote depth -> `DepthLadder`, wired into the existing provider interface.

**Phase 3 — Candles (the fallback killer)**
- `TPSeries` for 1/3/5/10/15/30/60/240-minute bars, `EODChartData` for daily.
- Register Shoonya ahead of Yahoo in candle resolution so `market-candles` serves broker bars and the chart header chip reads `history: shoonya` instead of `cache/yahoo`.

**Phase 4 — Account + trading**
- `Holdings`, `PositionBook`, `Limits` mapped into the existing `HoldingRow` / `PositionRow` / `FundsSnapshot` shapes, including T1 and pledged quantities, so `market-sync-holdings` and `market-sync-positions` work unchanged.
- `PlaceOrder`, `ModifyOrder`, `CancelOrder`, `ProductConversion`, `OrderBook`, `TradeBook`, with product/validity/exchange mapping (MIS->I, CNC->C, NRML->M, NSE/BSE segments).

**Phase 5 — WebSocket live feed**
- `wss://api.shoonya.com/NorenWSTP/`: connect frame `{t:"c", uid, actid, susertoken, source:"API"}`, subscribe `{t:"t"|"d", k:"NSE|token#NSE|token"}`, handling `tk/tf` touchline and `dk/df` depth deltas plus order updates.
- Added as a second adapter in the existing relay (`Apps/relay/`) so `liveTickStore` / `liveDepthStore` consume it with no frontend change.

**Phase 6 — UI and provider selection**
- `feedCatalog.ts`: new `shoonya` provider with its feeds (quotes, depth, daily candles, intraday candles, funds, holdings, positions, orders) and surface probes.
- `BrokerConnectPanel`: Shoonya card with connect / auto-login / test / disconnect.
- `getActiveProvider` / `getReadProvider`: choose the connected broker by explicit preference instead of hardcoding Kotak, Yahoo still last resort.

## Technical notes

- Base REST: `https://api.shoonya.com/NorenWClientTP/<Route>`, POST body `jData=<json>&jKey=<susertoken>`, form-encoded. Routes used: QuickAuth, Logout, SearchScrip, GetQuotes, GetSecurityInfo, TPSeries, EODChartData, Holdings, PositionBook, Limits, OrderBook, TradeBook, PlaceOrder, ModifyOrder, CancelOrder, ProductConversion. These route names come from the Noren/Shoonya Python SDK; Phase 1 begins by calling `QuickAuth` with the real credentials and confirming each route against a live response before mapping code is written — anything the live API disagrees with is corrected there rather than assumed.
- Sessions are day-scoped: Noren invalidates `susertoken` overnight, so the nightly cron re-runs `QuickAuth` with the TOTP seed, exactly like the Kotak refresh job.
- Noren rate-limits per route; quote polling goes through the existing `rateLimit.ts` and `routeBreaker.ts` guards.
- Kotak behaviour is untouched — both brokers coexist as `MarketProvider` implementations.

## Verification

- Live probe of every implemented route against the real account (read-only; no test order is ever placed).
- Unit tests for login digest construction, Noren envelope parsing, candle mapping and product/exchange mapping.
- End-to-end check in the preview: connect Shoonya, open a chart, confirm 5m bars arrive with `source: shoonya`, then confirm holdings/positions/funds match the Shoonya web terminal.