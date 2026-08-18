# Breakout module — verified bugs and fixes

Findings below are each backed by a code read or a query against `market_breakout_tracker` / `market_stock_scores`. The July audit's scoring-engine items (bar gate, turnover liquidity, pattern coverage) are confirmed already fixed in `scoring.ts` — they are not repeated.

## Confirmed data bugs (wrong numbers on screen today)

**1. Day-1 "Return %" is measured off the pivot, and the pivot can be 30% below price.**
`Breakout.tsx` switches the day-1 return basis to `trigger_price`. In the live table TARSONS shows entry 242.86 against a detection close of 361.50 (return +42.9%) while Peak reads +0.94% and MAE -4.88% — the same row reports a return larger than its own peak. Stored `current_return_pct` for every day-1 row is 0. Cause: `resistancePivot` accepts any cleared cluster up to **6 ATRs** below the close, so the "level broken" is often an old base ceiling far under price. Same pattern on MOREPENLAB (63.66 vs 89.82), TASTYBITE (9225 vs 10014), RATNAVEER (163 vs 230).

Fix: drop the pivot-as-entry substitution. Day-1 return is measured off the detection close (0.00%, rendered as "—" with a "detected today" tooltip). Show pivot distance as its own read, and tighten the trigger level used for episodes to a near-price band (about 1.5 ATR) so `trigger_price` means "the level it just cleared".

**2. Day-1 Peak and MAE are computed from the whole detection-day bar.**
The tick pass runs in the same session an episode opens, so entry = today's close while the high/low come from the full day, including the hours before the breakout. Live rows show MAE -9.11% (TVSSRICHAK) and -7.5% (EIMCOELECO) on their detection day — that is the day's range, not post-entry heat, and the opening-insert branch deliberately writes null for exactly this reason.

Fix: on the opening session leave `peak_close`, `peak_high`, `trough_low`, `mae_pct`, `peak_return_pct` null; start measuring from the next session.

**3. The Setup read fabricates inputs when data is missing.**
`close: meta.close ?? liveLtp ?? 0` feeds a 0 price into the ATR/pivot maths, and `bb_squeeze ?? false`, `near_resistance ?? false`, `base_tightness ?? 1` are indistinguishable from measured values. `atrContracting` is also derived from base tightness, which is a different measurement.

Fix: return NO DATA when price is missing, pass unknowns through as null, and stop synthesising `atrContracting`.

**4. `rollingHigh55` is ignored by the stage read.**
`breakoutStage.ts` falls back `pivotLevel ?? rollingHigh20` only, so a name whose only level is the 55-day high can never read ARMED or TRIGGERED even though the column is fetched.

**5. "New today" depends on the browser clock, not the data.**
The `new` view compares `first_detected_date` to a client-side IST date; before the pipeline runs, on a holiday, or on a skewed clock the tab is empty and indistinguishable from "nothing broke out". `daysAgo` also returns 0 for an unparseable date, printing it as "today".

Fix: derive "today" from the latest `first_detected_date` in the tracked set, label it with that date, and render unparseable dates as "—".

## Presentation and consistency

**6. Setup sorts alphabetically** (ARMED, COILED, EXTENDED, FAILED…) instead of the coil → armed → triggered → extended progression the tooltip describes.

**7. Lifecycle rules in `STATUS_META` are prose copies** of the 8% extend / 6% fail / 3 cool / 15 horizon constants; nothing keeps the legend and the state machine in step. Fix: build the strings from the shared constants.

**8. Threshold chips are 0/60/70/80** while the colours they use come from the 70/55/40 score bands. Fix: align the chips to the band boundaries.

**9. Live ticks follow episode order, not the visible rows.** The 100-symbol cap is applied to the unfiltered, date-sorted list, so filtering or searching can leave every visible row on last close while the header still reads Live. Fix: cap against the rows actually rendered.

**10. Geometry enrichment has no date bound.** `market_stock_scores` is queried for 300 symbols with every stored `trade_date` and no PostgREST limit; today that is one row per symbol, but as history accumulates the 1000-row default will silently truncate the tail of a chunk and those rows lose their Setup read. Fix: bound the query to the latest session and shrink the chunk.

## Order of work

1. Items 1 and 2 — stored and displayed numbers are wrong now.
2. Items 3, 4, 5 — wrong or fabricated reads.
3. Items 6-10 — consistency and egress.

## Technical notes

- Touches `src/routes/market/Breakout.tsx`, `src/lib/market/breakoutRun.ts`, `src/lib/market/breakoutStage.ts`, `supabase/functions/_shared/market/indicators.ts` (`resistancePivot` trigger band), `supabase/functions/market-pipeline-aggregates/index.ts` (opening-session peak/MAE), plus new cases in `tests/breakoutEpisode.test.ts` and a stage test file.
- No migration required. Existing day-1 rows will correct themselves on the next aggregates pass; already-stored day-1 MAE/peak values can be nulled by a one-off update in the same pass.
- After the trigger-band change, `trigger_price` on existing open episodes stays as stored (history), so the pivot column is backfilled only on the first tick where a near-price level exists.
