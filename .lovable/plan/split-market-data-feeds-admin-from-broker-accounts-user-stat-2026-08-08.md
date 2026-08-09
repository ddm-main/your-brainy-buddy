# Split market data feeds (admin) from broker accounts (user) — status and finish

Verified against the current code and database: the split is already built. What remains is verification and two small gaps.

## Already in place (verified)

- Database: `market_api_settings.purpose` (NOT NULL) exists; `market_feed_prefs.scope` (NOT NULL) exists with `user_id` now nullable.
- `getReadProvider()` uses only the designated data feed, then public vendors — the user-broker fallback is gone.
- `getSystemFeedRow()` selects only `is_system = true AND purpose = 'data'`; no "newest connected row" fallback.
- `getActiveProvider()` is scoped to `purpose = 'account'`.
- `resolver.ts` reads routing prefs from `scope = 'system'`.
- Kotak and Shoonya login functions accept a `purpose` and invalidate the system-feed cache for data rows.
- `DataFeedConnectionsPanel` and `FeedRoutingPanel` render in the admin Providers page; `BrokerConnectPanel` takes a `purpose` prop; `SystemFeedPanel` on `/market/settings` is read-only.

## Remaining work

1. **Regression test** — add `tests/readProvider.test.ts`: with a connected `purpose='account'` row present and no designated data feed, `getReadProvider` must return the Yahoo vendor provider, never the account row. Uses a stubbed Supabase client, no network.
2. **RLS check on `market_feed_prefs`** — confirm system-scope rows are readable by any authenticated user and writable only by `has_role(auth.uid(),'admin')`; add the policies via migration if that is not the case.
3. **Verification pass**
   - Run the vitest suite (`feedStatus`, `kotak*`, new read-provider test).
   - Browser check with Playwright: `/config/system-data` shows Data Feed Connections plus admin-only Feed Routing; `/market/settings` shows the read-only price-feed line plus the account-only broker panel.

## Technical notes

No schema change is expected beyond a possible policy fix on `market_feed_prefs`. No frontend rewrites; changes are limited to a new test file and, if needed, one RLS migration.
