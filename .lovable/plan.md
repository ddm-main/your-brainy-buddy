## Goal

Every signed-in user sees the same Market UI and the same data quality as the admin. Only genuinely personal things stay per-user: broker credentials, orders/trades, holdings/positions/funds, GTT, AutoTrade, watchlists, alerts, saved screeners, notes.

## What I verified in the code

- Market navigation (Overview / Screener / Breakout / Portfolio / AutoTrade / Config) is **not** role-gated — every tab is rendered for everyone. The 1D-return cell (`Return1DCell`, "+648.50 (+8.73%)") also comes from one shared column map used by both Overview and Screener.
  → So a user seeing a nav without BREAKOUT/CONFIG and an old `%`-only column is running an **older build** (published site / cached tab), not different code. Step 1 confirms this.
- Real, code-level divergence does exist at the **data** layer: `getActiveProvider(svc, userId)` only looks at that user's own `market_api_settings` row. With no Kotak connection, a normal user always falls back to delayed Yahoo — stale EOD prices, missing absolute change, "Data is 2 days behind" banner, no live LTP.
- These tables are user-scoped even though they hold *shared market knowledge*, so a normal user's copy is empty: `market_fundamentals`, `market_option_chain_snapshots`, `market_stock_ai`, `market_morning_insight_cache`. (`market_quotes`, `market_stock_scores`, `market_screener_rows`, breakout snapshots/tracker are already shared — good.)

## Plan

**1. Reproduce and pin the cause of the UI delta**
- Log in as the non-admin user in the preview with Playwright, screenshot Overview + Screener + nav, and diff against the admin view.
- If the preview already matches admin, the difference is the stale published build → republish and note it. If it doesn't match, fix whatever the diff shows.

**2. Shared read-only market feed (chosen: shared live data for everyone)**
- Add `getReadProvider(svc, userId)` in `supabase/functions/_shared/market/provider.ts`: use the user's own Kotak row when present, otherwise fall back to the app-level connected Kotak row (same logic as `getServiceProvider`), otherwise Yahoo.
- Switch **read-only** functions to it: quotes, candles, depth, indices, screener/breakout refresh, fundamentals, analysis, stock insight, top movers, market strip.
- Keep `getActiveProvider` (strict per-user) for anything account-bound: orders, trades, holdings, positions, funds, GTT, AutoTrade execution. A user without their own broker gets a clear "connect your broker to trade" state there — never someone else's account data.
- Broker credentials are never returned to the client; only derived market data.

**3. Shared reference data (migration)**
- Read fundamentals from the already-shared `market_fundamentals_global`; keep the per-user `market_fundamentals` only as a legacy cache, or add a shared read path so every user gets PE/ROE/growth columns in the screener.
- Make option-chain snapshots, AI stock insights, and the morning-insight cache readable app-wide (write stays service-role); add the GRANT + read policies in the same migration.
- Ensure `market_index_watch` defaults are seeded for every new user (indices strip shows NIFTY/SENSEX/BANKNIFTY/VIX for non-admins too).

**4. UI consistency sweep**
- Price-source chip / "15-min delayed Yahoo" banner: derive from the actual feed in use, so a non-admin on the shared live feed sees "LIVE · KOTAK" and no misleading connect-banner.
- "Data is N days behind" banner: keep, but base it on the shared EOD pipeline, not on per-user sync.
- Align default column presets (`columnPresets.ts` / localStorage keys) so a fresh browser gets the current 10-column layout, not the old 7-column one.
- Grep for every remaining `role === "admin"` branch outside Config → confirm only Admin Panel / System Data / Kotak reconnect modal are gated, and that Market Config shows the per-user broker section to everyone.

**5. Verify**
- Playwright side-by-side: admin vs normal user on Overview, Screener, Breakout, Portfolio, Analysis. Confirm identical columns, identical 1D-return format with absolute change, same LTP values, fundamentals populated, and that Portfolio/Orders correctly show the personal empty state for the non-admin.

## Technical notes

- Files touched: `supabase/functions/_shared/market/provider.ts`, the read-only `market-*` functions, one migration for shared read access on fundamentals/option-chain/AI/insight-cache, `src/components/market/PriceSourceChip.tsx`, `src/routes/market/Dashboard.tsx`, `src/routes/market/Screener.tsx`, `src/lib/market/columnPresets.ts`.
- No change to RLS on account-bound tables; the shared feed is server-side only (service client), so no broker token is exposed.
