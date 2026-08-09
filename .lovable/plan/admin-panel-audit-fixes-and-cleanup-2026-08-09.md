# Admin Panel — audit, fixes and cleanup

## What's actually broken (verified)

**Feed routing does not take effect.** The routing table writes per-user rows (`user_id` + `fallback_provider`, upsert on `user_id,feed_id`), but the server-side resolver only reads rows with `scope = 'system'`. The database currently has zero routing rows, and the unique index that the upsert targets no longer exists (the only unique index is on `feed_id where scope = 'system'`). So every "Primary/Fallback" change either errors or is silently ignored by the data pipeline.

**Duplicate/nested sections.** The admin area stacks three levels of chrome for two real pages:
- `/config` renders its own tab bar ("Market Config", "Admin")
- `SystemDataConfig` then renders a second "← config / Market Config" header plus a *third* tab bar ("Providers", "Storage & Quota")
- Inside Providers, three panels overlap in purpose: Data Feed Connections (+ an embedded broker form), Feed Routing, and Providers — all showing provider health with slightly different labels.

**Top nav.** On `/config` the nav still shows a "Market" chip; there is no indication you are in the admin panel.

**Verbose copy.** Paragraph explanations in Data Feed Connections, "use 'test everything' above" as a panel action, "idle feeds count as healthy", duplicated tally lines, oversized empty gaps in the routing panel.

## Plan

### 1. Fix feed routing (the real bug)
- Routing is an operator decision: write and read **system-scope** rows only (`scope: 'system'`, `user_id: null`), upserting on the existing `feed_id where scope='system'` index.
- "Reset to auto" deletes the system row for that feed.
- Read path (`useFeedPrefs`) filters to `scope = 'system'` so the panel shows what the resolver actually uses.
- Drop the per-user "yours · reset / routed manually (per-user override)" wording — replace with a plain "overridden · reset" affordance.
- Gate saving to admins (the panel already lives behind the admin route; surface a clear error instead of a silent failure if the write is rejected).
- Verify end to end: save an override, confirm the row exists with `scope='system'`, confirm the resolver's 30 s pref cache picks it up.

### 2. Flatten the navigation (kill duplicate sections)
One tab bar for the whole admin panel, rendered by `/config`:

```text
ADMIN CONFIG   [ Feeds & Providers ] [ Data Pipeline ] [ Storage & Quota ] [ Users ]
```

- Remove `SystemDataConfig`'s internal header ("← config", "Market Config") and its internal tab bar; it becomes plain page content per tab.
- Split today's "Storage" tab into "Data Pipeline" (sync buttons + pipeline stats) and "Storage & Quota" (DB/quota panel), so each panel has one job.
- Keep existing routes working via redirects (`/config/system-data`, `/config/market` → new tabs).

### 3. Compact the Feeds & Providers tab
- Merge **Data Feed Connections** into a single compact header strip: designated feed, status chip, last sync, last error, and a "designate" action per candidate row. Remove the explanatory paragraph and the always-mounted broker credential form — move it behind a "Connect / edit feed broker" action.
- **Feed Routing**: remove the empty spacer block, collapse the two tally rows into one line, remove the redundant "session closed · idle feeds count as healthy" sentence (keep session state as a small chip), keep the table dense and horizontally scrollable.
- **Providers**: remove the "use 'test everything' above" action text; keep a single global "Test all" button on the routing panel header and per-row Test buttons.

### 4. Top navbar
- On `/config*`, the nav renders a single active **ADMIN CONFIG** chip instead of "Market", with the Market link kept as the way back.
- Feed status chip keeps pointing at the Feeds & Providers tab.

### 5. Per-section verification pass
Drive the running app and check each tab: providers list + detail (sparkline, test), routing save/reset round-trip, pipeline sync buttons enable/disable and toasts, storage/quota panel, admin users (role change, section toggles, create, delete guard). Fix whatever breaks and report anything that needs a backend change.

## Technical notes
- Files touched: `src/routes/Config.tsx`, `src/routes/config/SystemDataConfig.tsx`, `src/routes/config/AdminConfig.tsx` (light cleanup only), `src/components/config/ProvidersPanel.tsx`, `src/components/config/providers/FeedRoutingPanel.tsx`, `src/components/config/providers/DataFeedConnectionsPanel.tsx`, `src/lib/market/feedStatus.ts`, `src/components/hud/TopBar.tsx`.
- No schema migration needed: `market_feed_prefs.scope` and the partial unique index already exist; only the client write/read path is wrong.
- Access rules unchanged — the admin route guard stays as-is.
