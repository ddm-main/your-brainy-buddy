# Screener: kill the false "1,307 no quote" chip and fix what causes it

## What I verified against the live database just now

- The screener universe is 1,350 symbols; `market_screener_rows` currently returns **1,349 rows, every one of them `quote_state = live` with `trade_date = 2026-08-12`**. So there is no real data hole right now.
- Today's live sweeps are healthy: the last runs are `complete`, `priced_count` 1,440 → 1,349 against `expected_count` 1,441 → 1,350 (the universe itself shrank mid-day). Last publish `as_of 10:38 UTC`.
- Scores are current: 1,349 score rows on 2026-08-12, none left on 2026-08-11.
- The view joins the live plane through a lateral gated on `lp.session_date >= today_IST`. When a symbol is not (yet) in today's live plane, `trade_date` falls back to the screener snapshot's settled date.

## Why the chip said "42/1,349 priced · 1,307 no quote"

`Screener.tsx` picks the reference session in Live mode as **the promoted sweep's `session_date`** (today) and then counts a row as "priced" only when `row.trade_date` **exactly equals** that date. Any row whose live-plane join hasn't landed yet — mid-sweep, before the first sweep of the day, or whenever the snapshot lags — falls back to the settled date and is counted as "no quote", even though it carries a perfectly good settled price, change% and volume.

That is a display *and* a filtering bug: the same exact-session gate feeds the Price / 1D Return / Volume filters, so during that window a screen can only match the handful of rows already in the live plane.

## Fix

### 1. Remove the chip as it stands
Delete the "N/N priced · N no quote" badge. It reports an internal join state, not a user-facing fact, and it is wrong for most of the trading day.

### 2. Replace it with an honest, rare indicator
Show a small note only when rows genuinely have **no quote at all** (`quote_state = 'no_quote'`, i.e. neither a live tick nor a settled close). Today that count is zero, so the screen stays clean. Keep the symbol list in the tooltip for the handful of real cases.

### 3. Fix the coverage / filter basis (the actual bug)
- A row counts as quoted when it has a usable price basis: today's live plane **or** the newest settled session — not "exactly equals the sweep's session date".
- Exact-session filters (1D Return, Volume, Breakout) evaluate the same basis the table renders for that row, so a row is never filtered on one number and displayed with another.
- When a row's basis is the settled session while the plane is live, the row is still eligible; its price cell keeps its existing settled/live labelling.

### 4. Keep the real staleness warnings
The "data is N days behind" and "scores behind settled prices" banners stay — those catch actual pipeline failure and are currently correct (both silent today).

## Technical notes

- `src/routes/market/Screener.tsx`: drop `sessionCoverage` / `excludedNoSession` chip block (~lines 1044-1058); derive a `noQuoteRows` count from `quote_state === 'no_quote'` instead; relax the exact-session gate used by `latestTradeDate` consumers so a settled-session row is a valid basis.
- No database migration and no edge-function change is needed — the pipeline is healthy; the defect is entirely in the client's session-reference logic.

## Out of scope (noted, not fixed here)

The universe moved 1,441 → 1,350 during today's session and `market_excluded_symbols` now holds 1,951 rows. That oscillation is worth a separate look, since every coverage denominator is built on it.
