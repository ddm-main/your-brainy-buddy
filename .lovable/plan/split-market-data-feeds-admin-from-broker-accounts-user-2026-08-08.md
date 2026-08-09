# Split market data feeds (admin) from broker accounts (user)

## The problem, verified in code

- `getReadProvider()` (`supabase/functions/_shared/market/provider.ts`) tries the designated system feed, then **falls back to `getActiveProvider(svc, userId)`** — the signed-in user's own broker connection. So quotes, candles, depth and indices are pulled through a user's personal broker session.
- `getSystemFeedRow()` has a "legacy fallback": when no row is designated `is_system`, it picks the **newest connected broker row of any user**. A user connecting Kotak for their portfolio can silently become the app's data feed.
- `market_feed_prefs` is **per-user** (`user_id` column, read per-user in `resolver.ts` and `src/lib/market/feedStatus.ts`), so feed routing is a personal setting rather than an app-wide admin decision.
- The system-feed designation UI (`SystemFeedPanel`) lives on the **user** page `/market/settings`, mixing app-wide data plumbing with personal broker connection.

Industry standard (Zerodha/Kite, Dhan, Fyers, algo stacks): one market-data plane owned by the operator (data broker / vendor keys), and a separate per-user trading plane bound to the user's own account. That is what we will build.

## What changes for you

**Admin Config → Market Config → Providers** becomes the only place feeds are configured:
- New "Data Feed Connections" panel: connect one or more brokers (Kotak Neo, Shoonya) **as data feeds only**, designate the active one, see login/token status and reconnect.
- Existing vendor providers (Yahoo, NSE, FMP, Alpha Vantage) stay here for fundamentals, technicals and reference data.
- Feed Routing (primary + fallback per feed) becomes **app-wide**, admin-only.

**Market → Config (user page)** becomes account-only:
- Connect your broker for funds, holdings, positions, orders, GTT, AutoTrade.
- Read-only line showing the app data feed's health (no controls).
- System-feed designation UI moves out of this page.

Consequence: if no admin data feed is connected, prices come from public vendors (Yahoo/NSE) — never from a user's broker.

## Technical plan

### 1. Database (migration)
- `market_api_settings`: add `purpose text not null default 'account'` with check `in ('account','data')`. Backfill `purpose='data'` for the row currently `is_system = true`. Keep `is_system` as the "designated data feed" flag but scope it to `purpose='data'`.
- `market_feed_prefs`: add `scope text not null default 'system'`; make `user_id` nullable; unique index on `(feed_id) where scope='system'`. Migrate existing rows of the admin user to `scope='system'`; drop the rest. RLS: everyone authenticated can read system-scope rows; only `has_role(auth.uid(),'admin')` can write them.
- Grants per the four-step rule on any new/changed table.

### 2. Backend
- `provider.ts`
  - `getSystemFeedRow()`: select only `purpose='data'` rows; **remove the "newest connected row" legacy fallback**.
  - `getReadProvider()`: system data feed → vendor providers (Yahoo/NSE). Delete the `getActiveProvider(userId)` fallback so user broker sessions can never serve market data.
  - `getActiveProvider()`: restrict to `purpose='account'` rows for the caller.
- `resolver.ts`: read routing prefs from `scope='system'` instead of `user_id`; keep the primary → fallback chain semantics already added.
- `market-system-feed`: `designate` accepts only `purpose='data'` rows; allow Shoonya as well as Kotak; keep status payload token-free.
- New/extended admin action to create a data-feed connection row (`purpose='data'`, owned by the admin who created it) so `market-config-save` and the Kotak/Shoonya login functions can target it explicitly by `id` rather than by "the caller's row".
- Kotak/Shoonya login + probe functions: take an explicit settings row id (defaults to the caller's account row) so admins can log in the data-feed connection without touching their personal one.

### 3. Frontend
- `src/components/config/providers/DataFeedConnectionsPanel.tsx` (new): list `purpose='data'` rows, connect/reconnect/designate, token expiry and last error. Rendered in `ProvidersPanel` above the vendor list.
- `FeedRoutingPanel`: read/write system-scope prefs, admin-only, list every feed group (Live, History, Account, Reference) with the existing status pills.
- `src/routes/market/Settings.tsx`: drop `SystemFeedPanel` controls; render a compact read-only feed-health line plus `BrokerConnectPanel` labelled "Broker account (funds, positions, orders)".
- `BrokerConnectPanel`: accept a `purpose` prop so the same form serves both admin data-feed and user account connections.

### 4. Fixes rolled in while touching this
- Cache invalidation: call `invalidateSystemFeedCache()` on designate, on data-feed reconnect and on data-feed credential save.
- Feed status UI: distinguish "data feed down" from "your broker disconnected" so account errors no longer imply the price feed is broken.

### 5. Verification
- Run the existing vitest suite (`feedStatus`, `kotak*` tests) plus a new test that `getReadProvider` never returns a user's account row.
- Browser check: `/config/system-data` shows the data-feed panel and admin-only routing; `/market/settings` shows account-only broker UI.
