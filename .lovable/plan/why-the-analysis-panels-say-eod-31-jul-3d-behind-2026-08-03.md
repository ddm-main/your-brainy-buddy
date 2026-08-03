# Why the analysis panels say "EOD 31 Jul · 3d behind"

## What the data actually shows (verified in the live DB)

- `market_daily_prices`: last full session written is **2026-07-31** (2,761 symbols). 2026-08-03 has only **29 rows**, written one-by-one during today's session (DBL's own row was created at 10:24 UTC while the market was open) — this is ad-hoc per-symbol chart/quote persistence, not the bhavcopy.
- `market_stock_scores`: last full scoring pass is **2026-07-31** (2,711 symbols). 2026-08-03 has 26 rows; DBL's newest score row is **2026-07-31**.
- Cron schedule: `market-nse-bhavcopy-sync` runs 12:30 UTC, `market-daily-sync-postclose` 13:15 UTC, `market-rescore-snapshot-postclose` 13:45 UTC. Current time is 10:31 UTC (16:01 IST), so today's EOD pass has not run yet. 1–2 Aug were the weekend.

So the numbers are not "loading older data" by mistake: the Breakout/Indicators panels are EOD-derived and the newest completed EOD session genuinely is 31 Jul until tonight's pass runs. The bug is in how the page describes it:

1. `useLatestPriceSession` (`src/lib/market/hooks.ts`) takes `max(trade_date)` over *all* rows, so 29 partial intraday rows make it believe a full 2026-08-03 session exists — turning a normal "waiting for tonight's EOD" state into a red-flag "pipeline is behind".
2. `sessionsBehind` in `src/routes/market/Analysis.tsx` divides calendar milliseconds by 86,400,000, so 31 Jul → 3 Aug reads "3d behind" even though only one trading session (today) is missing, and today isn't settled yet.
3. Nothing on the page tells you when the next EOD refresh happens, so the stale chip looks like a failure rather than a schedule.

## Fix

1. **Make "latest session" mean a real session**
   - Change `useLatestPriceSession` to return the newest `trade_date` that has a full-market row count (e.g. the newest date with more than a few hundred NSE rows), so partially-written intraday days are ignored.
   - Have it also return whether today has a partial/unsettled write, for the chip copy.

2. **Count trading sessions, not calendar days**
   - Compute "behind" as the number of distinct stored sessions between the score date and the latest complete session, so a weekend or a not-yet-run EOD never inflates the number.
   - When the score date equals the latest complete session, show a neutral `EOD 31 Jul` chip with no "behind" suffix and no warn colour.

3. **Explain the state instead of alarming**
   - Neutral chip + tooltip: "Latest settled EOD session (31 Jul). Today's EOD pass runs after 18:00 IST."
   - Keep the warn colour only for the genuine failure case: the score date is older than the latest *complete* stored session.

4. **Apply the same rule everywhere the chip appears**
   - Breakout Intelligence header, Indicators (Daily) header, and the Quote/score vintage chip all read from one shared helper, plus the Screener usage of `useLatestPriceSession`, so no two panels can disagree.

Out of scope (unchanged): the EOD pipeline schedule itself and the intraday per-symbol daily-row writes — those keep working as they do today.

## Technical notes

- `src/lib/market/hooks.ts` — `useLatestPriceSession`: query completed sessions (count-gated) and return `{ latestComplete, partialToday }`.
- `src/routes/market/Analysis.tsx` — replace the calendar-day `sessionsBehind` math with session-count math, restructure `vintageChip` tone/copy, reuse it in the Breakout and Indicators headers.
- `src/routes/market/Screener.tsx` — adapt to the new return shape.
- No schema or edge-function changes required.

## Validation

- On DBL right now: chips read `EOD 31 Jul` in neutral tone with the "next pass after 18:00 IST" tooltip, no "3d behind".
- After tonight's 13:45 UTC rescore: chips move to `EOD 03 Aug`.
- Simulated case where scores lag a complete price session: chip returns to warn tone with `· 1 session behind`.
