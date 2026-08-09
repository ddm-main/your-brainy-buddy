# Market app — deep check and repair

Everything below was confirmed against the live database and the actual files today (2026-08-08). The UI layer is largely fine; the breakage is concentrated in the build, the credential chain, and the data pipeline.

## What I confirmed

| Check | Live value | Verdict |
|---|---|---|
| Live sweeps failed | 165 runs | broken |
| Last `complete` sweep | 2026-08-05 10:05 UTC | 3 sessions stale |
| Last sweep coverage | expected 2518 / scanned 2641 / priced 1572 | denominator wrong |
| Tradable universe (active NSE, non-penny) | 1765 | 1572/1765 = 89% |
| `market_intraday_prices` | 0 rows | charts have no fallback |
| `market_quotes` | 0 rows | empty |
| Scores vs screener date | 2026-08-07 vs 2026-08-06 | screener a session behind |
| Provider health error | `Decryption failed` | secret missing/rotated |
| Broker connection status | `connected`, `expired` | one session dead |
| Chart history route | `kotak:charts/v2/history` → `404 page not found` | dead route |
| Holidays table | 23 rows | healthy |

The failing sweep error is literally `coverage below promotion threshold` — the sweep priced 1572 symbols but was measured against 2518, so the gate can never pass even though real coverage against the universe it actually stages is 89%.

## Step 0 — Unblock the build (must run first)

The build fails at install. `package.json` declares `overrides: { "@supabase/phoenix": "0.4.4" }`, but the root entry in `package-lock.json` has **no** `overrides` field recorded, while `@supabase/realtime-js` in the lock depends on `@supabase/phoenix@0.4.5`. `npm ci` refuses a lockfile that disagrees with the manifest.

Regenerate `package-lock.json` from `package.json` so the override is recorded in the lock, then verify a clean install and a clean build before anything else lands.

## 1. Restore the credential chain

- Generate a fresh `STATEMENT_ENC_SECRET` and wire it to the edge functions — `Decryption failed` in provider health is the direct symptom.
- The old ciphertext is unrecoverable. The two stored provider credential rows must be re-entered once from Market Config → Providers.
- Providers panel currently collapses three different states into one error. Split them: **key missing**, **key undecryptable**, **session expired** — each with its own action, so an expired Kotak session doesn't read as a decryption bug.

## 2. Fix live price promotion coverage

- Measure expected coverage against the same universe the sweep actually stages (active NSE, token present, not penny-excluded) rather than the raw universe. On today's numbers that moves the gate from 62% to 89%.
- Record numerator and denominator on the run row so the next mismatch is visible immediately instead of surfacing as a generic threshold failure.

## 3. Stop the EOD pipeline aborting the daily chain

- Classify "symbol has no data upstream" (Yahoo 404 / unknown scrip) as *permanently unavailable* and flag the symbol so it leaves the candidate pool instead of being retried every run.
- Return an error only for real failures (network, schema, auth). A batch that is entirely permanent-404s reports `ok` with a skip count.
- Move the screener-snapshot refresh so it always runs, even when an earlier step failed. That is why the screener sits at 2026-08-06 while scores are at 2026-08-07.

## 4. Charts and intraday

- Correct the Kotak history route — `charts/v2/history` is returning 404 and the breaker has it recorded. Verify the current documented path and update `KOTAK_CANDLES_ROUTE`.
- Write intraday cache rows only when a fetch genuinely returns bars, so `market_intraday_prices` stops being empty and charts have something to fall back on during an outage.
- Keep the strict "Kotak-only during market hours" rule, and keep chart state honest when the broker is down: explicit "broker unavailable", never silently delayed data presented as live.

## 5. Provider hygiene

- Surface FMP / Alpha Vantage "key not configured" and Shoonya "authorize required" as setup prompts in Config rather than repeating them as health-log errors.
- Soften the BSE bhavcopy step so a multi-day drought is not treated as a hard failure of the chain.

## 6. Frontend cleanup

- Freshness chip on Top Movers so weekend / pre-market EOD numbers are not shown as if live.
- Remove the orphaned `src/routes/market/Calibration.tsx` — the `calibration` route already redirects to Breakout and the file is imported nowhere.
- Nav entries for `backtesting` and `planner` are **already present** in `nav.ts`; no work needed there.

## Technical notes

- **Lockfile**: regenerate `package-lock.json` so the root entry records the `@supabase/phoenix` override; confirm `npm ci` then `vite build` both succeed.
- **DB migration**: rewrite `promote_market_live_sweep` / `begin_market_live_sweep` coverage math to the tradable-universe filter, and add numerator/denominator columns to `market_live_price_runs`. No schema change to price tables.
- **Edge functions**: `market-pipeline-eod` (error classification + permanent-unavailable flag), `market-daily-sync` (snapshot refresh always runs), `market-candles` (history route fix + intraday cache write guard), `market-live-sweep` (coverage logging), and the `market-provider-credentials` path.
- **Secret**: `STATEMENT_ENC_SECRET` added via the secrets tool.
- **Frontend**: `TopMoversPanel.tsx`, `ProvidersPanel.tsx`, delete `src/routes/market/Calibration.tsx`.

## Needs you once

After the secret is in place, re-enter the Kotak login/API details in Market Config → Providers (and FMP / Alpha Vantage keys if you want those providers active). Nothing else requires your input.
