
# Market — Breakout Intelligence (Phase 1 MVP)

Replace the Notes route with a full `/market` sub-app modelled on `/finance`. Phase 1 gets Kotak Neo authenticated, live quotes flowing, and the Dashboard / Holdings / Watchlist screens real. All other spec sections (Screener, Analysis, Positions, Alerts, Backtesting, Analysis Report, Settings extras) get scaffolded routes with a "coming soon" state so navigation and DB tables exist, and Phase 2+ can fill them without churn.

## 1. Remove Notes
- Delete `src/routes/Notes.tsx` and its route registration in `src/App.tsx` / `TopBar.tsx`.
- Remove Notes from any command palette entries.

## 2. Navigation & routing
- New top-level nav item **Market** → `/market/*`.
- `src/routes/Market.tsx` renders a left sidebar (matching `Config.tsx` / `Finance.tsx` styling) with sub-routes:
  - `/market` — Dashboard
  - `/market/screener` — scaffold
  - `/market/analysis` — scaffold (+ `/market/analysis/:symbol` detail scaffold)
  - `/market/holdings`
  - `/market/positions` — scaffold
  - `/market/watchlist`
  - `/market/alerts` — scaffold
  - `/market/backtesting` — scaffold
  - `/market/settings` — API Configuration (real)

## 3. Provider abstraction
- `supabase/functions/_shared/market-providers/` with:
  - `types.ts` — `MarketProvider` interface (`getQuote`, `getQuotes`, `getHoldings`, `getPositions`, `search`, `getHistorical`, `getIndices`)
  - `kotak-neo.ts` — real implementation (login, session refresh, quote, portfolio, scrip master lookup)
  - `yahoo.ts` — read-only fallback for indices/quotes when no Kotak session
  - `index.ts` — `getActiveProvider(userId, svc)` reads `market_api_settings.active_provider` and returns adapter.
- All edge functions call through this layer; switching provider is a single row update.

## 4. Database (migration)
Tables (all with `user_id`, RLS `auth.uid() = user_id`, standard GRANTs, `updated_at` trigger):

- `market_api_settings` — `provider` (enum: `kotak_neo|yahoo|zerodha|dhan`), `consumer_key`, `consumer_secret_enc`, `mobile_number_enc`, `password_enc`, `mpin_enc`, `base_url`, `ws_url`, `access_token_enc`, `session_token_enc`, `sid`, `hs_server_id`, `token_expires_at`, `last_sync_at`, `connection_status`, `rate_limit`.
- `market_stocks` — `symbol`, `exchange`, `token`, `company_name`, `sector`, `industry`, `series`, `lot_size`, `isin` (shared reference table; grants for authenticated read).
- `market_daily_prices` — OHLCV per symbol/date.
- `market_intraday_prices` — OHLCV per symbol/timestamp (retention 5 days).
- `market_holdings` — symbol, quantity, avg_price, buy_date, investment_type, notes, source (`manual|kotak_sync`).
- `market_positions` — entry_price, qty, side, stop_loss, target, opened_at, closed_at, pnl.
- `market_watchlists` + `market_watchlist_items` — name, color, notes, priority, tags, symbol.
- `market_alerts` — symbol, alert_type, threshold, channel (`browser|email`), triggered_at.
- `market_saved_screeners` — name, filter_json.
- `market_saved_strategies` + `market_backtest_results` — strategy_json, metrics_json, equity_curve_json.
- `market_portfolio_notes` — symbol, note.
- `market_indicators_cache` — symbol, timeframe, indicator, value, computed_at.
- `market_user_prefs` — theme, default_timeframe, default_risk_pct, refresh_seconds.

Enum `market_provider` created up front.

## 5. Secrets & encryption
- Reuse the existing `STATEMENT_ENC_SECRET` pattern (`_shared/crypto.ts`) to encrypt Kotak credentials at rest. No new project-level secret needed; per-user credentials live encrypted in `market_api_settings`.

## 6. Kotak Neo auth flow (edge functions)
- `market-kotak-login-start` — takes consumer key/secret + mobile/password/MPIN, calls Kotak `/login/1.0/login/v2/validate` → session token; stores encrypted; returns `otp_required: true`.
- `market-kotak-login-otp` — takes OTP, calls Kotak 2FA endpoint, stores `sid`, `hs_server_id`, `access_token`, `token_expires_at`; sets `connection_status = 'connected'`.
- `market-kotak-refresh` — checks `token_expires_at`; if <10 min or expired, prompts re-OTP (frontend catches and opens OTP modal).
- `market-test-connection` — fetches user profile to verify.
- All functions: JWT-required, zod-validated inputs, CORS headers, provider-error surfacing per gateway pattern.

## 7. Data-sync edge functions
- `market-sync-holdings` — pulls Kotak portfolio → upserts `market_holdings` (source=`kotak_sync`), preserves manual rows.
- `market-sync-positions` — pulls day/net positions.
- `market-quotes` — batch quote fetch (Kotak L1 quote API); response cached in `market_quotes` for 15s.
- `market-indices` — Nifty/Sensex/BankNifty/Midcap/Smallcap/VIX via Kotak scrip tokens; falls back to Yahoo if Kotak fails.
- `market-search` — symbol search over `market_stocks`.
- `market-scrip-master-refresh` (cron daily 07:30 IST) — downloads Kotak scrip master CSVs, upserts `market_stocks`.
- `market-eod-snapshot` (cron 16:00 IST) — pulls day OHLCV for tracked symbols → `market_daily_prices`.
- `market-breakout-score` (stub returning 0 for Phase 1; real engine in Phase 2).

## 8. Frontend — Phase 1 real screens

**Settings › API Configuration** (`/market/settings`)
- Provider dropdown, credential form (masked), Save, Test Connection, session status chip, "Complete OTP" button opening a modal (`OtpDialog`) that calls `market-kotak-login-otp`.
- Shows `last_sync_at`, `token_expires_at` countdown, active provider.

**Dashboard** (`/market`)
- Market Summary strip: Nifty/Sensex/BankNifty/Midcap/Smallcap/VIX (from `market-indices`).
- Advance/Decline + breadth panel (from indices response; Phase 1 shows what Kotak/Yahoo returns, marks unknowns as `—`).
- Top Breakout Stocks + Pre-Breakout tables: query `market_holdings` + `market_watchlist_items` symbols, show quote data with placeholder breakout score = null and "Score engine coming in Phase 2" tooltip.
- Watchlist Summary tiles.
- AI Daily Insights: reuse `jarvis-finance-insight` pattern with a new `market-morning-insight` edge fn (Lovable AI Gateway, cached daily in `morning_briefs`-style table extension — piggyback on existing `morning_briefs` with `kind='market'`).

**Holdings** (`/market/holdings`)
- Table: symbol, qty, avg buy, LTP, invested, current value, P/L absolute + %, today's change.
- Add/Edit/Delete manual holdings dialog.
- "Sync from Kotak" button.
- Portfolio summary cards: total investment, current value, day P/L, overall return, count.
- Sector allocation donut (uses `market_stocks.sector`).
- AI insight columns (breakout prob / recommendation) render `—` in Phase 1.

**Watchlist** (`/market/watchlist`)
- Multiple watchlists (create/rename/delete).
- Add symbol via search-autocomplete against `market-search`.
- Per-item color, priority, notes, tags.
- Live LTP, day %, distance to 52w high.

**Positions / Screener / Analysis / Alerts / Backtesting** — scaffold pages with headline, one paragraph description, and a disabled "Configure" panel. Route + DB tables exist so Phase 2 slots in.

## 9. State, styling, libs
- Add `@tanstack/react-query` (if not already), `lightweight-charts`, `@tanstack/react-table`.
- Reuse existing `HudPanel`, `Btn`, `Chip`, HUD styling — no new theme.
- No dummy data anywhere: empty states say "Connect Kotak Neo to see live data" with a link to `/market/settings`.

## 10. Out of scope for this plan (explicitly deferred)
- Breakout probability engine, pre-breakout detector, trade planner math.
- Screener filter builder and saved screeners UI.
- Backtesting engine, equity curve, metrics.
- Custom report builder / Excel/PDF export.
- Alert delivery (browser/email/Telegram).
- TradingView chart on the analysis page (Phase 2 with `lightweight-charts`).
- WebSocket streaming quotes (Phase 2; Phase 1 polls every `refresh_seconds`, default 15s).
- Multi-user auth changes — uses existing single-user setup.

## Technical notes
- Kotak Neo REST base: `https://gw-napi.kotaksecurities.com/` with per-env `neo-fin-key`. Two-step login: `/login/1.0/login/v2/validate` → OTP → `/login/1.0/login/v2/validate` again with OTP → returns `sid`, `hsServerId`, `token`.
- Session token expires daily ~00:00 IST → login-otp flow re-run required; UI proactively surfaces the OTP dialog when a call returns 401.
- Scrip master: daily CSV per exchange (`nse_cm`, `bse_cm`, `nse_fo`, `bse_fo`, `cde_fo`, `mcx_fo`); Phase 1 imports `nse_cm` + `bse_cm` only.
- Encryption: `encrypt(value, STATEMENT_ENC_SECRET)` from `_shared/crypto.ts` (AES-GCM); we'll rename usage but keep the same secret.
- All new edge functions declared in `supabase/config.toml` with `verify_jwt = true` except cron ones (`verify_jwt = false`, called by pg_cron with service key header).

## Deliverables checklist
- [ ] Migration approved (16 tables + enum + trigger + policies + grants).
- [ ] `Notes.tsx` removed, nav updated.
- [ ] Provider adapter layer.
- [ ] 10 edge functions above.
- [ ] Kotak OTP dialog + settings page.
- [ ] Dashboard / Holdings / Watchlist real.
- [ ] Scaffolds for the other 5 sub-routes.
