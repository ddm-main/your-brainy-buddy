# Fix the admin data-feed vs. user broker split, and the stale/false Kotak statuses

## What the data shows (verified)

- There are three broker connection rows: Kotak `purpose='account'` (connected), Kotak `purpose='data'` (connected, designated system feed), Shoonya `purpose='account'` (expired). Neither Kotak row currently holds an access/session token even though both say "connected".
- The self-test probes **account surfaces against the data-feed row**: `runSelfTest` calls `surfaceReport(..., "kotak_neo", "data")` and that report includes `funds`, `holdings`, `positions`. That is why Funds/Holdings/Positions appear — and fail — inside the admin data-feed provider page.
- The Kotak probe rows in the database are from 2026-08-08 09:54 (about a day old) and still render as red FAILED, because the UI accepts probes up to 24 h old and there is no "not re-checked" state. The stored details are `no rows` (quotes), `Broker session expired` (funds), `Saved Kotak credentials can no longer be decrypted` (holdings/positions), `depth returned no bid/ask levels` (depth, off-session).
- Intraday candles show NO DATA for Kotak because the catalog intentionally has no Kotak probe there (Kotak publishes no candle API) but the row still renders a status cell from an empty table read.
- The user broker screen (`Market → Config`) shows only connect/portfolio controls: it never reads `market_surface_probes`, so the user has no per-surface health for their own account.
- `market_surface_probes` is unique on `(surface, provider)` only — an account-plane probe and a data-plane probe of the same surface overwrite each other today.

## Plan

### 1. Separate the two planes in the probe data
- Add a `plane` column (`'data'` | `'account'`) to `market_surface_probes`, move the unique key to `(surface, provider, plane)`, and delete the existing account-surface rows written under the data plane.
- `runSelfTest`: probe only data surfaces (quotes, index quotes, depth, candles) against the `purpose='data'` row, and probe account surfaces (funds, holdings, positions) against the signed-in user's `purpose='account'` row, stamping the plane on each.
- Feed/provider health tallies count data-plane rows only, so a personal broker problem can never read as a platform outage.

### 2. Admin provider page = shared data feeds only
- Mark each catalog feed with a scope (`feed` vs `account`). Kotak/Shoonya account feeds (funds, holdings, positions, order placement) leave the admin provider detail table.
- Kotak rows that Kotak cannot serve (daily candles, intraday candles, index quotes) collapse into one short line stating Yahoo/NSE serves them, instead of four rows with empty status cells.

### 3. User broker page = your account surfaces
- Add an "Account feed health" block to the user broker screen showing Funds / Holdings / Positions / Orders with status, last check time and the recovery action, read from account-plane probes for that user's broker.
- Order placement stays a labelled write path (never test-probed).

### 4. Kill stale-status lies
- Probes older than a threshold (60 min in session, 6 h off session) render as `not checked` with the last verdict as secondary text, instead of a red FAILED chip.
- When the visible probes are stale and the viewer is an admin, auto-run the self-test once per page visit (already the pattern used by feed routing auto-retry).
- Off-session `depth returned no bid/ask levels` renders as IDLE, not degraded.

### 5. Fix the connection-status lie
- A row with no usable session token must not report `connected`. Status derivation reports `expired` (reconnect) when the token is missing or past expiry, on both the admin and user screens, so "connected but every feed fails" cannot happen.
- Re-run the self-test after the fix and confirm each Kotak surface reports a current, honest verdict.

## Technical notes
- Migration: `market_surface_probes` gains `plane text not null default 'data'`, new unique index, cleanup delete; grants unchanged.
- Edge: `supabase/functions/_shared/market/selftest.ts` (probe split + plane stamping), `supabase/functions/market-test-connection/index.ts` (pass plane through).
- Client: `src/lib/market/selftest.ts` (plane-aware reads, staleness rules), `src/components/config/providers/feedCatalog.ts` (feed scope), `ProviderDetail.tsx`, `FeedRoutingPanel.tsx`, `src/components/market/BrokerConnectPanel.tsx` (account health block).
- Verification: run the market provider/self-test tests, call `market-selftest` and `market-test-connection` directly, then re-query `market_surface_probes` to confirm plane separation and fresh verdicts.
