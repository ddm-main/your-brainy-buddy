# Screener vs Economic Times: why the numbers disagree

## What I verified against the live database (2026-08-04, 15:50 IST)

Your ET filter set (Price > 100, Mcap > 1000 Cr, 1D > 8%, Volume > 30D avg) returns 10 stocks. The app returns 1. The cause is not the filter logic — it's the data the filters run on.

**1. Today's session is a half-written, mid-morning snapshot.**
`market_daily_prices` has 2,821 rows for 2026-08-03 but only **1,569** for 2026-08-04, and every one of those 08-04 rows was created between 10:00 and 10:54 IST — i.e. they are *forming intraday bars*, not closes. Same shape in `market_stock_scores` (1,567 rows for 08-04). Examples:

| Stock | ET (real close, 08-04) | App snapshot | App trade_date |
|---|---|---|---|
| Man Infracons | 111.61 / +11.82% | 104.80 / +4.99% | 2026-08-04 (10:30 IST bar) |
| Ather Energy | 1,450.40 / +13.97% | 1,272.70 / +0.98% | 2026-08-03 (no 08-04 row) |
| KEI Industries | 5,500.00 / +9.49% | 5,023.30 / +0.49% | 2026-08-03 |
| Vedant Fashions | 485.90 / +16.04% | 435.50 / +4.00% | 2026-08-04 (partial) |
| Paushak | 735.20 / +12.63% | 674.90 / +3.39% | 2026-08-04 (partial) |
| Ujaas Energy | 202.91 / +10.00% | 184.47 / +20.00% | 2026-08-03 |

**2. The exact-session gate then deletes the other 1,233 stocks.**
`filterMatches` (screenerCatalog.ts:351) drops any row whose `trade_date` differs from the latest session for ltp / change_pct / volume / rel_volume / vol_gt_avg30. `latestTradeDateOf` only refuses to treat *today* as the reference session while the market is open (`settledOnly`). It is now 15:50 IST — market closed, but the real 08-04 close data has **not** arrived yet (today's NSE bhavcopy is still 08-03: `market_eod_nse` max trade_date = 2026-08-03). So the partial 08-04 date is accepted as "settled", every stock stuck on 08-03 is silently filtered out, and the surviving 08-04 rows carry morning prices. That is exactly the "1 of 2800" you saw, and why the chip reads "EOD 2026-08-04 · same-session values" while showing 10:30 IST numbers.

**3. The writer that creates the partial session.**
`market-pipeline-eod` (index.ts ~215-227) fetches ~30 Yahoo daily bars per symbol and upserts them all, including today's still-forming bar — with no `nseSessionOpen()` guard (the equivalent guard *does* exist in `market-candles`, line 479). Because it works through a bounded batch of symbols per run, only part of the universe gets an 08-04 row → the mixed-date snapshot.

**4. Post-close refresh is far too late.**
`market-daily-sync-postclose` runs at 13:15 UTC = **18:45 IST**. Between 15:30 and 18:45 IST the screener has no path to real closes at all.

**5. Universe gaps.** Glenmark Life (NSE: GLS), one of ET's 10, does not exist in `market_stocks` — it can never appear regardless of filters.

**6. Cosmetic mismatch.** ET's volume column is in thousands ('000); the app shows raw shares. Not a bug, but it makes side-by-side comparison look wrong.

## Fix plan

**A. Never persist an unsettled bar into the daily table.**
Add the same grain/settlement guard `market-candles` uses to `market-pipeline-eod` (and audit `market-history-backfill`, `market-score-backfill`): drop any bar whose `trade_date >= today IST` unless the session is closed **and** the bar is confirmed settled (bhavcopy present for that date, or Kotak/Yahoo marked the bar final). Result: no more half-universe partial sessions.

**B. Make the reference session provably settled, not just "the newest date present".**
Replace the `nseSessionOpen`-only rule with a real settlement check: a date is eligible as reference session only if it has broad coverage (e.g. ≥90% of the active EQ universe) **and** a settled source (`market_eod_nse` row for that date). Until 08-04 settles, the screener falls back to 08-03 for *all* symbols — consistent values across the board instead of a 1,567/1,233 split. Surface it honestly in the header chip: `EOD 2026-08-03 · settled` / `08-04 forming`.

**C. Report coverage instead of silently deleting rows.**
When rows are dropped by the exact-session gate, the results header shows "1,233 stocks excluded — no 2026-08-04 session yet" with a one-click "use last settled session" action, so a partial pipeline can never look like an empty market again.

**D. Real intraday parity (what ET actually shows).**
ET's 1D% during/just after the session is live-vs-previous-close. In Live mode the screener must compute `change_pct` from the live LTP against the *settled previous close*, for the whole candidate set — not only rows that already survived the EOD pass. Today the live pass can only re-rank rows the EOD pass let through, so a stock frozen on 08-03 can never re-enter. Fix: build live candidates from the full universe for live-capable filters (batched), keeping the bounded cadence.

**E. Close the post-close hole.**
Move the post-close sync to ~15:50 IST (10:20 UTC) driven by broker/Yahoo closes, keep the 18:45 IST bhavcopy run as the authoritative reconciliation pass, and re-run scoring + snapshot refresh after each.

**F. Universe completeness.**
Add a reconciliation check of `market_nse_master` (2,395 rows) and the bhavcopy symbol list (3,194 rows) against `market_stocks`, reporting/inserting missing active EQ symbols such as GLS. Add it to `market-data-validation` so gaps are visible.

**G. Volume unit.** Add a "'000" display option (or a tooltip stating the unit) on the Volume column to make ET comparisons unambiguous.

**H. Tests.**
- A partial session (60% coverage, no bhavcopy) is not eligible as reference session.
- Bars dated today while the session is open/unsettled are never persisted.
- Exact-session gate keeps the full universe when all rows share the settled date.
- Live-mode 1D% is computed from live LTP ÷ settled previous close and matches the displayed cell.

## Verification after the fix

Re-run your exact ET filter set in the app and compare stock-by-stock against the ET list; the settled-session run should reproduce ET's 10 names (minus symbols genuinely absent from the universe until F lands), and Live mode should track ET's intraday 1D% within rounding.
