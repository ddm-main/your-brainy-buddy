# Cutover to the restored Supabase project (olwxfgrnbxkpoeofyfcm)

I inspected both the repo and the new database before writing this. The data restored well; everything *around* the data did not.

## Verified state of the new project

| Check | Result |
|---|---|
| Tables in `public` | 121, with 230,101 daily price rows, 3,225 stocks, 3 auth users, 3 role rows |
| Data API grants (anon / authenticated / service_role) | **0 tables** — no role has any grant |
| Row Level Security | on for 110 tables, **off for 11** (tasks, transactions, subscriptions, tax_entries, threads, user_roles, user_page_access, system_*) with 133 policies total |
| Scheduled jobs (`cron.job`) | **0** — every schedule was lost |
| Vault secrets | **0** (the cron secret the jobs post with is gone) |
| Edge function secrets | only `LOVABLE_API_KEY` — all others missing |
| Storage | 3 buckets exist, **0 objects** (statement PDFs, vision uploads, archives did not come across) |
| Realtime publication | empty — no table published |
| Frontend target | still hardcoded to the **old** project in `src/integrations/supabase/client.ts` and `src/lib/supabaseSafe.ts`; `.env` already points to the new one |

So right now the app in the browser is still reading the old project, and if it were pointed at the new one every query would fail with a permission error.

## Work to do, in order

**1. Point the app at the new project**
- `src/integrations/supabase/client.ts`: new URL + new publishable key.
- `src/lib/supabaseSafe.ts`: `SAFE_SUPABASE_URL` → new project (this is what every direct edge-function fetch in `src/lib/market/api.ts` uses).
- `supabase/config.toml` `project_id`, and `supabase/.temp/linked-project.json`.

**2. Restore Data API grants (one migration)**
Per-table grants for all 121 public tables: `SELECT/INSERT/UPDATE/DELETE` to `authenticated`, `ALL` to `service_role`. `anon` gets `SELECT` only on tables whose policies are genuinely public — I will list those from the policy catalogue and confirm with you before granting anything to `anon` rather than granting broadly.

**3. Turn RLS back on for the 11 unprotected tables**
`tasks`, `transactions`, `subscriptions`, `tax_entries`, `threads`, `user_roles`, `user_page_access`, `system_egress_daily`, `system_maintenance_log`, `system_quota_state`, `system_retention_config`. I will re-derive each table's policies from the migrations in `supabase/migrations/` so the restored rules match the original intent, not a guess.

**4. Re-create the secrets**
Missing and needed by edge functions: `CRON_SECRET`, `SYNC_HOOK_SECRET`, `MARKET_CRON_SECRET`, `KOTAK_PROBE_KEY`, `APP_ORIGIN`, `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` (Gmail), `FINANCIAL_MODELING_PREP_API_KEY`, `OPENROUTER_API_KEY`, `SHOONYA_PROXY_URL` / `_SECRET`, plus the statement/session encryption key used by `_shared/crypto.ts`.

Two classes here:
- Internal random values (cron/sync secrets, probe key) — I can generate and store them without you.
- Third-party keys (Google OAuth, FMP, OpenRouter, Shoonya proxy) — you paste them; I will open the secure form for each.
- **The encryption key must be the exact same value as on the old project**, otherwise every stored Kotak session and statement password becomes undecryptable. Please copy it across rather than letting me mint a new one.

Google OAuth also needs the new project's callback URL added in the Google Cloud console, since the redirect URI contains the project ref.

**5. Re-create the schedules**
Rebuild every `cron.schedule` from the migrations (market sweeps, EOD pipeline, self-test, maintenance, gmail sync due, autotrade eval), store the cron secret in Vault the way `verify_market_cron_secret` expects, and verify with one manual invocation per job family.

**6. Realtime + auth settings**
Re-add the tables that were published to `supabase_realtime` (watchlists / live prices / ticks as the client hooks expect), and re-check auth settings on the new project: site URL, redirect URLs (`/reset-password`), signup blocking trigger, email confirmation, and leaked-password protection.

**7. Storage**
Buckets exist but are empty. Historical statement PDFs and vision uploads need re-uploading from the old project if you still have access to it — I cannot copy objects from a backup that only contained the database. Tell me if the old project is still reachable and I will script the copy; otherwise the affected records will show missing files.

**8. Verification pass**
Deploy all 98 edge functions against the new project, then: log in as your user in the app, walk Market (quotes, chart, breakout, calibration), Finance (accounts, statements, txns), Inbox and Tasks, and check function logs for permission errors. Fix whatever the pass turns up.

## Technical notes

- Grants and RLS are separate: adding grants alone leaves the 11 unprotected tables world-readable through the Data API, so steps 2 and 3 must land together.
- `verify_market_cron_secret` reads from Vault; step 4's cron secret and the Vault entry in step 5 must be the same value.
- Keep the old project alive read-only until step 8 passes, so nothing is stranded.

## Open questions before I start

1. Is the old project still accessible (for the encryption key and for storage objects)?
2. Should `anon` keep read access to any market reference tables, or should everything require login on the new project?
