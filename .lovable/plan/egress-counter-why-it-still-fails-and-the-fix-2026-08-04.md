# Egress counter — why it still fails, and the fix

## What I verified just now

1. **The function is not deployed.** `POST /functions/v1/usage-egress-sync`
   returns `404 NOT_FOUND`, while `admin-users` and `market-candles` return
   `401` (deployed, auth required). That 404 is exactly what produces the toast
   "Egress sync failed: Failed to send a request to the Edge Function" — the
   browser's `functions.invoke` cannot reach a function that does not exist.
2. **No management token exists.** The project has exactly one secret
   (`LOVABLE_API_KEY`). `SB_MANAGEMENT_TOKEN` / `SB_PROJECT_REF` were never
   added, so even once deployed the function would return
   `{ ok:false, error:"SB_MANAGEMENT_TOKEN is not configured" }` and the bar
   would stay empty.
3. **The database side is already in place.** Migration `20260804053238` added
   `egress_window_start/end`, `egress_limit_bytes`, `egress_budget_bytes`,
   `egress_breakdown`, `egress_synced_at`, extended `quota_report()` and created
   `apply_egress_governor()`. Migration `20260804065043` schedules the cron job
   `usage-egress-sync` at `5 2,14 * * *` through `market_cron_call`, which posts
   to `…/functions/v1/usage-egress-sync` with the vault cron secret — that job
   is currently posting into a 404 as well.
4. **The Management API call in the function is built wrong.** It sends
   `attributes=<comma list>`, `start_date`, `end_date`. The daily-stats endpoint
   takes a single `attribute` per request plus `startDate`/`endDate`
   (camelCase), so even with a valid token the response would carry no rows and
   the panel would show 0 B.
5. The panel and the navbar chip already read the figure correctly and hide it
   until `egress_synced_at` is set, so no UI rework is needed beyond error text.

## The fix

### 1. Get the function actually deployed
Redeploy `supabase/functions/usage-egress-sync` (a no-op edit forces the deploy)
and confirm with a direct request that it answers `401`/`200` instead of `404`
before touching anything else. Add its `verify_jwt` entry to
`supabase/config.toml` only if the deploy needs it.

### 2. Ask for the Supabase management token
Request `SB_MANAGEMENT_TOKEN` as a secret (a personal access token from
supabase.com/dashboard/account/tokens). Also set `SB_PROJECT_REF` explicitly
rather than deriving it from the URL. Without this token no real egress number
exists — the Management API is the only source.

### 3. Correct the Management API call
- One request per attribute: `total_auth_egress`, `total_rest_egress`,
  `total_storage_egress`, `total_realtime_egress`, `total_func_egress`, with
  `interval=1d`, `startDate`, `endDate` covering the current billing cycle.
- Sum each series over the window, store the per-type split and the total.
- On a non-2xx from the Management API, return the status and the first part of
  the body so the toast says what is actually wrong (bad token, wrong ref, rate
  limit) instead of a generic failure.
- Keep writing `egress_bytes`, `egress_breakdown`, the window dates and
  `egress_synced_at`, then call `apply_egress_governor()`.

### 4. Make the failure legible in the UI
- The Egress button reports the function's real error message (token missing,
  API 4xx) rather than "Failed to send a request".
- The row keeps saying "not synced yet" until `egress_synced_at` is set, and
  shows the last-sync time and cycle window once it is.

### 5. Verify end to end
Call the deployed function with the cron secret, check
`system_quota_state.egress_bytes` is non-zero and the split matches the billing
page's proportions (PostgREST dominant), then reload the panel and confirm the
Egress bar and the navbar chip both light up.

## Note on the rest of pass 3
Steps A (pipeline projection), B (cron cadence) and C (client projections) from
the earlier plan are separate from this failure; I will confirm which of them
landed and report any that did not once the counter is reporting real numbers —
having the counter working first is what makes the rest measurable.

## Technical notes
Files: `supabase/functions/usage-egress-sync/index.ts`,
`src/components/config/DatabaseStoragePanel.tsx`, possibly
`supabase/config.toml`. New secrets: `SB_MANAGEMENT_TOKEN`, `SB_PROJECT_REF`.
No schema migration needed — the columns, `quota_report()` and the governor
already exist.
