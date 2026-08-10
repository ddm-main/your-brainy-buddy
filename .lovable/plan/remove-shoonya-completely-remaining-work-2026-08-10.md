# Remove Shoonya completely — remaining work

Most of this pass is already done. Verified just now:

- No `shoonya` string remains in `src/` (apart from the generated Supabase types) or in `supabase/functions/` — the client, master sync, login/probe/oauth functions, provider/feedRoute/heartbeat/selftest/sweepSnapshot branches, and all frontend entries are gone.
- Database is clean: `market_stocks.shoonya_token` no longer exists, and there are 0 rows left in `market_feed_prefs`, `market_api_settings`, `market_provider_health` and `market_surface_probes` referencing Shoonya.
- `Apps/relay/shoonya-proxy.mjs` and `Resources/shoonya-authentication.md` are already deleted.

What is left:

## 1. Delete the deployed edge functions

The source is gone but the deployed functions may still be live. Delete from the Supabase project:
`market-shoonya-login`, `market-shoonya-probe`, `market-shoonya-master-sync`, `shoonya-oauth-callback`.

## 2. Record the retirement

- Append a line to `System/Logs/2026-08-10.md`: Shoonya retired as broker and data provider; code, functions and data removed; `depth` falls back to Kotak only.
- Add a dated entry to `System/Memory/decisions.md` explaining the decision and the why (Kotak Neo stays the broker; Yahoo/NSE/FMP stay the vendors), so it is not re-proposed.

## 3. Verify

- `bunx vitest run` — confirm the suite is green (no Shoonya-specific tests remain).
- `rg -i shoonya src supabase/functions` — expect only the generated `market_provider` enum label in `src/integrations/supabase/types.ts`.

## Technical notes

The `market_provider` enum keeps its `shoonya` label — Postgres cannot drop an enum value safely, and nothing writes it any more. That is why the generated types file still mentions it; no code change can remove it and no migration is needed.
