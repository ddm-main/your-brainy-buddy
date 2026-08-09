# Cutover audit: restored project olwxfgrnbxkpoeofyfcm

I inspected the repo and queried the new database before writing this. The data restored well; the things *around* the data did not.

## What I verified just now

| Check | Result |
|---|---|
| Frontend target (`client.ts`, `supabaseSafe.ts`, `.env`, `config.toml`) | all already on **olwxfgrnbxkpoeofyfcm** — nothing to change |
| Tables in `public` | 121, 231,018 price rows, 3,225 stocks, 3 users, 3 role rows |
| **Data API grants** | **0 tables have any grant** for anon / authenticated / service_role |
| Row Level Security | enabled on all 121 tables, 133 policies, **0 policies reference `anon`** |
| Scheduled jobs | 28 restored (backup vintage) |
| Vault | 1 secret: `market_cron_secret` |
| Edge function secrets | only `LOVABLE_API_KEY` — 13 others missing |
| Storage | 3 buckets exist, **0 objects** |
| Realtime publication | empty |
| Database size | 143 MB (comfortable) |

**The blocker is grants.** RLS is correct, but PostgREST has no privileges on any table, so every query from the app returns `permission denied` regardless of policy. Nothing else can be verified until that lands.

## Work, in order

**1. Restore Data API grants (one migration)**
`SELECT/INSERT/UPDATE/DELETE` to `authenticated` and `ALL` to `service_role` on all 121 public tables. No `anon` grants — no policy in the restored database allows anon, so granting it would only widen exposure. Also re-grant `USAGE` on the public schema and on sequences.

**2. Re-create the missing secrets**
Required by the functions (from a scan of `Deno.env.get` across all 98):
- I generate: `CRON_SECRET`, `SYNC_HOOK_SECRET`, `MARKET_CRON_SECRET`, `KOTAK_PROBE_KEY`, `APP_ORIGIN`.
- You paste: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `FINANCIAL_MODELING_PREP_API_KEY`, `OPENROUTER_API_KEY`, `SHOONYA_PROXY_URL`, `SHOONYA_PROXY_SECRET`.
- **Must be the exact old value:** `STATEMENT_ENC_SECRET`. Minting a new one makes every stored statement password and broker session permanently undecryptable.
- `MARKET_CRON_SECRET` must equal the Vault entry `market_cron_secret` that `verify_market_cron_secret()` reads — I will align them.

Google OAuth also needs the new project's callback URL added in the Google Cloud console; the redirect URI contains the project ref.

**3. Deploy all 98 edge functions** against the new project, then smoke-test one per family (market quotes/candles, pipeline, gmail sync, jarvis chat, finance extract) and read logs for permission or missing-secret failures.

**4. Reconcile the schedules**
The restored 28 jobs are from the backup, so everything added after it is gone and one is stale:
- missing: `jarvis-daily-maintenance`, `market-archive-prices-drain`, `market-archive-prices-nightly`, `market-close-snapshot`, `market-penny-sweep`
- stale: `market-history-backfill` is back at `*/3` (it was moved to `*/15` for quota reasons)
Re-create the missing ones and restore the interval, then trigger one job per family manually and confirm a 200 in the logs.

**5. Realtime** — re-add the tables the client hooks subscribe to (live prices / ticks / watchlists) to `supabase_realtime`.

**6. Auth** — site URL, redirect URLs including `/reset-password`, email confirmation, the signup-blocking trigger, leaked-password protection; then a real sign-in with your account.

**7. Storage** — buckets exist, objects do not. Statement PDFs, vision uploads and archive objects need copying from the old project while it is still reachable; the archive objects the drain job will simply regenerate.

**8. Verification pass, signed in as you** — Market (quotes, chart, breakout, screener, calibration), Finance (accounts, statements, transactions), Inbox, Tasks, Config. Fix whatever it turns up. Keep the old project alive read-only until this passes.

## Technical notes

- Grants and RLS are independent; the grant migration is safe here precisely because RLS is already on for all 121 tables.
- Restores do not carry edge-function secrets, Vault contents beyond what was dumped, storage objects, or the realtime publication — that matches exactly what I found.

## Before I start

1. Is the old project still reachable, for `STATEMENT_ENC_SECRET` and storage objects?
2. Confirm no page should be readable while signed out (that is what the no-`anon`-grants decision assumes).
