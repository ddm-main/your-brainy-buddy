# Penny-stock purge + weekly re-check

Remove penny stocks from the market universe and keep them out automatically, re-evaluated once a week.

## The rule

A stock is a penny stock if **either** holds:
- market cap below ₹1,000 Cr (rows with no market cap on record are not judged on cap)
- last traded price below ₹50

No exemptions — the rule applies to holdings and watchlist symbols too.

Against the latest settled session (2026-08-05), that flags **1,203 of the 2,823** universe symbols today.

## How exclusion works

Today the universe is `market_stocks.in_universe`, and three jobs keep flipping it back to true (weekly NSE master sync, nightly scrips sync, index constituents, BSE bhavcopy seeding). So a one-off update would silently reverse itself within a day.

Fix: a durable penny flag that those jobs respect.

- New columns on `market_stocks`: `penny_excluded` (bool), `penny_reason` (text, e.g. `cap<1000cr`, `ltp<50`, `cap<1000cr+ltp<50`), `penny_checked_at`.
- A penny-flagged symbol gets `in_universe = false`; the flag is the reason it stays false.
- The jobs that force `in_universe = true` are patched to skip rows where `penny_excluded` is true, so nothing re-admits a penny stock behind the sweep's back.

## Weekly sweep

New edge function `market-penny-sweep` (cron-secret gated, same pattern as the other market crons):

1. Reads every NSE equity with its market cap and the close from the latest settled session.
2. Marks as penny anything failing either threshold → `penny_excluded = true`, `in_universe = false`, reason + timestamp stamped.
3. **Reinstates** any currently-excluded stock that now clears both thresholds → `penny_excluded = false`, `in_universe = true` (so a stock that re-rates or crosses ₹50 comes back on its own).
4. Skips stocks that are inactive/delisted (`is_active = false`) — those are already out for a different reason.
5. Logs the run into `market_ingestion_runs` (`source: penny_sweep`) with counts excluded / reinstated / unchanged, and refreshes the screener snapshot so the change is visible immediately.

Scheduled weekly on Saturday after the existing universe jobs settle (`market-nse-master-sync` 02:00, `market-scrips-sync` 02:00, `market-fno-list-sync` 03:00 UTC Sat) — the sweep runs at **04:15 UTC Saturday**, so it always has the freshest master list to work against.

## What you'll see

- Screener, breakout, scoring and AI-recommendation universes all narrow to the ~1,620 non-penny names, since every one of them reads from the same universe/snapshot.
- No UI work is required for the purge itself; the Config → Database & Storage panel already shows universe counts and ingestion runs, so the sweep's result is inspectable there.

## Technical notes

- Migration: add the three columns (defaults `false` / `null`), plus a partial index on `penny_excluded` for the sweep's update paths.
- Initial purge runs as part of the first sweep invocation (called once right after deploy) rather than as a data migration, so the same code path produces the first result and the weekly result.
- `market_cap` is stored in ₹ crores in this schema, so the cap test is literally `market_cap < 1000`.
- Price source is the latest settled `market_daily_prices.close` (not intraday live), matching how the screener resolves its session.
- Files touched: new `supabase/functions/market-penny-sweep/index.ts`; patches to `market-scrips-sync`, `market-nse-master-sync`, `market-bse-bhavcopy-sync`, `market-index-constituents` to respect `penny_excluded`; one cron schedule insert.
