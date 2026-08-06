# Screener ⇢ Economic Times parity: root causes and fixes

I queried the database directly, ran your exact filter set (Price > 100, MCap > 1000 Cr, 1D > 6%, Volume > 30D Avg) against the live plane, and compared every one of ET's 13 stocks against our stored values. Here is what is actually wrong.

## The headline finding

Every stock ET showed **is already in our database with near-correct live values**:

| Stock | ET | Our live plane | Verdict |
|---|---|---|---|
| New India Assurance | 184.55 / +7.45% | 181.84 / +5.86% | present, minutes behind |
| Go Digit | 279.45 / +6.14% | 278.70 / +5.85% | present |
| ASK Automotive | 587.00 / +6.48% | 600.50 / +8.92% | present |
| Elantas Beck | 11364.50 / +15.11% | 11240.00 / +13.85% | present |
| KDDL | 4032.60 / +10.40% | 3963.80 / +8.51% | present |
| Cello, Rashi, PTC, Electronics Mart, Uniparts, La Opala, JG Chem | match | all present | present |
| V-Marc | in ET results | **flagged inactive, no live quote** | bug |

So the data is not missing. **The screen was reading the wrong plane.** Your screenshot's chip says `EOD 2026-08-04 · same-session values` and `Filters · EOD` — the app filtered yesterday's settled closes while ET filtered today's live session. Two different days of movers, which is why zero of the 15 overlapped the 13.

## The six real bugs behind the mismatch

**1. Live/EOD mode is silently wrong, and the mode chip is easy to miss.**
The screen can sit in EOD mode during market hours because a remembered toggle wins, so a screen run mid-session compares against yesterday's close. Filters must follow the session, not a stored preference.

**2. Garbage 1D-return values dominate the results.**
38 symbols in the live plane carry absurd changes — BEWLTD at **+2409%**, SABEVENTS +1900%, MOS +1742%, IEML +753%, RADIOWALLA +337%. No NSE cash stock can move beyond its circuit band in a session. These illiquid/SME prints flood any "1D > 6%" screen and push real movers off the page. There is no sanity guard today.

**3. Market cap is never revalued at the live price.**
425 of 2,821 active stocks have **no share count at all**, and 379 have no market cap. Where shares are missing, the screen falls back to a cap anchored to yesterday's close, so the MCap > 1000 Cr gate admits and rejects the wrong stocks. This is the KEI Industries discrepancy you spotted — ET revalues cap continuously, we don't.

**4. Live coverage is smaller than the screen claims.**
The universe has 2,821 active stocks; the live plane holds **2,575**. That is 246 stocks with no live quote, plus **120 more with no volume** — yet the rail reports "2,793 / 2,829 priced · 36 no quote", because that count is computed off the EOD plane. The screen is overstating its own coverage.

**5. Universe scope is wider than ET's.**
ET screens NSE mainboard EQ series. We include SME-board and thinly traded series, which is where most of the junk in bug 2 originates. Separately, V-Marc is marked inactive in our universe despite being a live, legitimate ET result — universe reconciliation is dropping valid symbols.

**6. Volume basis defaults to a different definition than ET's.**
Our default is pace-adjusted (session volume vs a pro-rated average). ET uses raw cumulative volume vs the full 30-day average. Same filter name, different maths, different result set.

Additionally the sweep publishes every 5 minutes and the client polls at 60s, so worst case a price is ~6 minutes stale against ET's near-tick feed.

## The fix

**Session-truthful mode.** During NSE hours the screener resolves to live unconditionally and the stored preference cannot override it; the mode chip becomes a prominent, unambiguous state, and the volume basis defaults to raw so it means what ET means by the same label.

**Quote sanity gate.** Reject any live print whose move exceeds the instrument's circuit band or disagrees with a second provider beyond tolerance. Rejected quotes fall back to the settled close and are marked, never silently screened as a 2409% gainer.

**Live market-cap revaluation.** Backfill the 425 missing share counts, then compute cap as shares x live LTP on every sweep so the MCap gate and the displayed value match ET's continuously revalued figure. Rows without a share count are marked unjudgeable rather than filtered on a stale cap.

**Honest coverage telemetry.** The rail reports coverage against the plane the filters actually used, naming live-plane gaps and no-volume symbols instead of quoting EOD coverage.

**Universe reconciliation.** Add a mainboard-EQ scope matching ET's default, keep SME behind an explicit opt-in, and fix the reconciliation that wrongly deactivated V-Marc and similar live symbols.

**Tighter cadence.** Shorten the sweep interval and client poll during market hours so worst-case age stays under a minute.

**A parity harness.** A repeatable check that runs your exact filter set and reports every symbol we return that ET wouldn't and vice-versa, with the reason (no shares, rejected quote, out of scope, stale). This is how "no compromise in the data" stays true after today.

## Technical notes

- Sanity gate and live-cap recompute land in `market-live-sweep`; derived fields travel on the plane row so filters and cells can never disagree.
- Mode resolution and coverage telemetry live in `src/routes/market/Screener.tsx` and `src/lib/market/screenerRun.ts`, reusing the existing `projectRowsForMode` projection so there is still one row set and no overlay drift.
- Share-count backfill extends `market-shares-outstanding-sync`, writing provenance so each cap value can name its source and date.
- Circuit bands and the mainboard-EQ series flag come from the NSE security master via the existing `nseClient`.

## One question before I build

Your 15-row screenshot included Ather Energy, KEI, CG Power and similar — all real names, all yesterday's movers. Confirm you want ET's definition as the target (NSE mainboard EQ only, live session, raw volume basis). If you also want SME stocks screenable, I'll keep them behind a toggle rather than dropping them.