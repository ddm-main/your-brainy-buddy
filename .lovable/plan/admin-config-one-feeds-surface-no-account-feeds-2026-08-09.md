# Admin Config: one feeds surface, no account feeds

## What's there now (verified)

- `ProvidersPanel` renders three stacked panels on the Feeds & Providers tab: **Data Feed Connection**, **Feed Routing**, **Providers**. The first two overlap with the third — Data Feed Connection lists the same Kotak/Shoonya rows the Providers list already shows, plus a "use as feed" button and a hidden broker credential form.
- **Feed Routing** still renders an `account` group: Funds / margin, Holdings, Positions, Orders (read), Order placement — that is the "Account · your broker account · 4/5 healthy" block in the current view, with its own separate tally.
- The provider detail view already filters to data-plane feeds (`scope === "data"`), and `AccountHealthPanel` on **Market → Config** already renders exactly those account surfaces from account-plane probes. So the admin copies are duplicates, not the only place they exist.

Separately, the last build failed on a lockfile inconsistency (`@supabase/storage-js` 2.110.8 vs the 2.112.2 the lock pins), so `npm ci` aborts. That gets fixed first — nothing else can be verified until the build is green.

## Plan

### 0. Unblock the build
Regenerate `package-lock.json` so the `@supabase/supabase-js` → `@supabase/storage-js` pin resolves consistently, and confirm a clean install succeeds.

### 1. Retire the separate "Data Feed Connection" panel
- Delete `DataFeedConnectionsPanel` and stop rendering it from `ProvidersPanel`.
- The two things it uniquely did move into the Providers list, where the provider already has a row:
  - the **active data feed** marker becomes a chip on the Kotak/Shoonya row (`active feed`), with a `use as feed` action on the other broker row;
  - **connect / edit feed broker** stays reachable from that row's existing Edit action (it already routes to the broker form).
- The designated-feed status line (provider, last sync, last error, "vendors only" when nothing is designated) becomes a single compact line in the Providers panel header, so there is one place that answers "what is serving market data right now".

### 2. Admin Config shows feeds only — no account surfaces
- Remove the `account` group from Feed Routing: the table renders `live`, `history` and `reference` only.
- Drop the separate account tally and the account counts from the panel's health chip, so the header describes platform feeds alone. A personal broker session problem can no longer read as a platform outage.
- Any leftover system-scope routing rows for account feeds are cleaned up, since routing an account surface app-wide is meaningless.
- Account surfaces stay exactly where they belong: **Market → Config → Account feed health**, which already covers Funds, Holdings, Positions and Order placement for the signed-in user's broker.

### 3. Verify each surface
Drive the running app: `/config/feeds` (one feed panel, no account block, designate/edit still work, self-test refreshes statuses) and `/market/settings` (account health block still shows all four surfaces with honest states). Fix anything that breaks.

## Technical notes
- Files touched: `src/components/config/ProvidersPanel.tsx`, `src/components/config/providers/FeedRoutingPanel.tsx`, delete `src/components/config/providers/DataFeedConnectionsPanel.tsx`; `package-lock.json` for the build fix.
- `feedCatalog.ts` keeps its `account` entries — `AccountHealthPanel` reads them; only the admin panel stops rendering them.
- No schema migration. No change to the routing resolver or to how prices are served.
