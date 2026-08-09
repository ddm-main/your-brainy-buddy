# Cutover to the restored project (olwxfgrnbxkpoeofyfcm)

I queried the new database and read the repo before writing this. The data restored well and the schedules survived. The permissions layer and every secret did not — that is what is actually broken.

## Verified right now, on the new project

| Check | Result |
|---|---|
| App target (`client.ts`, `supabaseSafe.ts`, `.env`, `config.toml`, linked project) | all already on **olwxfgrnbxkpoeofyfcm** — nothing to repoint |
| Tables in `public` | 121, prices current to 2026-08-07, 3 users, 3 role rows, 4 page-access rows, 463 transactions, 29 statements |
| **Data API grants** | **zero** for `anon`, `authenticated` and `service_role` — and no `USAGE` on the schema |
| Row Level Security | on for all 121 tables, 133 policies, no policy grants `anon` |
| Scheduled jobs | 33 present and complete |
| Vault | 1 secret: `market_cron_secret` |
| Edge function secrets | only `LOVABLE_API_KEY` — 14 others the functions read are missing |
| Storage | `market-archive` has 168 objects; `statement-pdfs` and `jarvis-vision` are empty |
| Encrypted rows that need the old key | 6 card passwords, 2 account passwords, 2 broker credential rows, 1 Gmail refresh token |
| Realtime publication | empty — and no client code subscribes to `postgres_changes`, so nothing is needed |
| Tables with RLS but no policy | `market_live_price_stage`, `market_ticker_trace` (service-role-only, deliberate) |
| Database size | 143 MB — comfortable |

**The blocker is grants.** RLS is correct, but PostgREST holds no privileges on any table, so every request from the app returns a permission error no matter what the policies say. Nothing else can be verified until that lands.

Separately, the last build failed: `package-lock.json` pins `@supabase/supabase-js` against `@supabase/storage-js@2.110.8` while the resolved tree wants `2.112.2`, so `npm ci` aborts. That is unrelated to the migration but blocks every build, so it goes first.

## Work, in order

**1. Unblock the build**
Regenerate `package-lock.json` so the supabase-js and storage-js versions agree, then confirm a clean install and build.

**2. Restore Data API grants (one migration)**
`USAGE` on `public` plus `SELECT/INSERT/UPDATE/DELETE` to `authenticated` and `ALL` to `service_role` on all 121 tables and the sequence, and default privileges for future tables. No `anon` grants: no policy in the restored database allows anon, so granting it would only widen exposure. This is safe precisely because RLS is already on everywhere.

**3. Re-create the secrets**
From a scan of every `Deno.env.get` across the 98 functions:
- I generate and store: `CRON_SECRET`, `SYNC_HOOK_SECRET`, `MARKET_CRON_SECRET`, `KOTAK_PROBE_KEY`, `APP_ORIGIN`.
- You paste: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `FINANCIAL_MODELING_PREP_API_KEY`, `OPENROUTER_API_KEY`, `SHOONYA_PROXY_URL`, `SHOONYA_PROXY_SECRET`.
- **Must be the exact old value:** `STATEMENT_ENC_SECRET`. The 8 stored statement passwords and 2 broker credential rows above are AES-GCM sealed with a key derived from it; a new value makes them permanently undecryptable.
- `MARKET_CRON_SECRET` must equal the Vault entry `market_cron_secret`, which `verify_market_cron_secret()` checks — I will align them so the 33 cron jobs authenticate.

Google OAuth also needs the new project's callback URL added in the Google Cloud console, since the redirect URI contains the project ref. Until that is done the one stored Gmail refresh token will not exchange.

**4. Deploy all 98 edge functions** to the new project, then smoke-test one per family — market quotes/candles, EOD pipeline, screener snapshot, gmail sync, jarvis chat, finance extract — and read the logs for permission or missing-secret failures.

**5. Verify the schedules end to end**
The jobs exist; what is unproven is that they can authenticate and write. Trigger one job per family manually and confirm a 200 plus a fresh row in `market_ingestion_runs`.

**6. Auth settings**
Site URL, redirect URLs including `/reset-password`, email confirmation, the signup-blocking trigger, leaked-password protection — then a real sign-in with your account and a check that role and page-access gating still resolves.

**7. Storage**
`statement-pdfs` and `jarvis-vision` are empty, so existing statement rows will show a missing file. Those objects need copying from the old project while it is still reachable; the archive objects the drain job regenerates on its own.

**8. Verification pass, signed in as you**
Market (quotes, chart, breakout, screener, calibration), Finance (accounts, statements, transactions, one statement decrypt), Inbox, Tasks, Projects, Config. Fix whatever it turns up. Keep the old project alive read-only until this passes.

## Technical notes

- Grants and RLS are independent; restoring a dump carries policies but not role privileges, which is exactly the state I found.
- Restores also do not carry edge-function secrets, Vault contents, storage objects, or the realtime publication — again matching what I found.
- The two policy-less tables stay policy-less; they are written only by the service role, which bypasses RLS.

## Before I start

1. Is the old project still reachable? I need it for `STATEMENT_ENC_SECRET` and for the statement/vision storage objects.
2. Confirm nothing should be readable while signed out — that is what the no-`anon`-grants decision assumes.
