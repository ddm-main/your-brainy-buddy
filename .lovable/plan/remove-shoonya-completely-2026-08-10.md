# Remove Shoonya completely

Shoonya (Finvasia / Noren) is retired as a broker and as a data provider. Kotak Neo stays the broker; Yahoo/NSE/FMP stay the vendors.

## What changes for you

- Shoonya disappears from Feed Routing selectors, the provider catalog, provider health cards and the broker connect screen.
- Any feed currently pinned to Shoonya falls back to its normal chain (today only `depth` has Shoonya as fallback — it becomes Kotak only).
- The stored Shoonya connection and its health history are deleted.

## Backend removal

Delete these edge functions (code + deployed):
- `market-shoonya-login`
- `market-shoonya-probe`
- `market-shoonya-master-sync`
- `shoonya-oauth-callback` (and its `[functions.shoonya-oauth-callback]` block in `supabase/config.toml`)

Delete shared modules `_shared/market/shoonyaClient.ts`, `shoonyaClient_test.ts`, `shoonyaMaster.ts`.

Strip Shoonya branches from:
- `_shared/market/provider.ts` — `shoonyaProvider`, token map priming, settings columns, chain entries
- `_shared/market/feedRoute.ts` — remove from `RouteProvider`, `BASE_CHAIN`, `DEFAULT_CHAIN`
- `_shared/market/heartbeat.ts`, `_shared/market/selftest.ts`, `_shared/market/sweepSnapshot.ts` (drop the shoonya token map from the daily snapshot)
- `market-live-sweep`, `market-candles`, `market-test-connection`, `market-config-save`, `market-feed-routing`, `market-system-feed` (broker list)

Redeploy every touched function.

## Frontend removal

- `src/components/config/providers/feedCatalog.ts` — drop the `shoonya` provider entry, `PROVIDER_ORDER` slot, `RoutedProvider` union member, routing labels, and every `chain: [... "shoonya"]` entry.
- `src/components/market/BrokerConnectPanel.tsx` — remove the whole Shoonya card, OAuth code exchange, redirect-URL helper and its state.
- `src/components/market/PriceSourceChip.tsx`, `src/components/market/AccountHealthPanel.tsx`, `src/components/config/ProvidersPanel.tsx`, `src/components/config/providers/ProviderDetail.tsx`, `src/lib/market/hooks.ts`, `src/lib/market/selftest.ts`, `src/lib/market/feedStatus.ts` — remove Shoonya ids, labels and comments.

## Database

Data cleanup (one migration + data statements):
- Repoint `market_feed_prefs`: `provider='shoonya'` → `'kotak'`, `fallback_provider='shoonya'` → `NULL` (affects 1 row: `depth`).
- Delete the 1 `market_api_settings` row with `active_provider='shoonya'` and the 20 `market_provider_health` / 3 `market_surface_probes` Shoonya rows.
- Drop `market_stocks.shoonya_token` (all NULL) and rebuild the `market_universe` view without that column.

The `market_provider` enum keeps its `shoonya` value — Postgres cannot drop an enum label safely and nothing will write it after this pass.

## Docs

Delete `Apps/relay/shoonya-proxy.mjs` and `Resources/shoonya-authentication.md`; log the retirement in `System/Logs/2026-08-10.md` and note the decision in `System/Memory/decisions.md`.

## Verification

- `bunx vitest run` (drop/adjust Shoonya-specific tests).
- Trigger a live sweep and a candles fetch, confirm coverage matches the last run and no `shoonya` string remains: `rg -i shoonya src supabase`.
