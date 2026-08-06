# Screener vs Economic Times: the live filters are rejecting every live-priced row

## What I verified against the live system (2026-08-05, market open)

- The five-minute live plane is healthy. The last promoted sweep (`06:00:01 UTC`) holds **2,575 priced rows**, one `sweep_id`, one `as_of`, 0 rejects, Kotak-sourced.
- The live prices themselves match Economic Times closely. Sampled against the ET screen: NIACL 182.40 (+6.19%), PTC 195.17 (+6.39%), KDDL 3,944.80 (+7.99%), RPTECH 938.30 (+7.74%), CELLO 379.65 (+10.09%), JGCHEM 536.80 (+6.14%), LAOPALA 201.87 (+6.07%). The data is not the problem.
- In `market_screener_rows` right now: **2,575 EQ rows carry `trade_date = 2026-08-05`** (live) and only **254 carry `2026-08-04`**.
- The screener's reference-session resolver, while the market is open, refuses today's date and — reproduced with the real counts — resolves to **`2026-08-04`**.
- The freshness gate used by the Price / 1D Return / Volume / Volume>30D-Avg / Rel-Volume filters rejects any row whose `trade_date` is *newer* than the reference session (`lagDays < 0` → not applicable).

**Root cause:** in Live mode the row's `trade_date` becomes the live session date (today), but the filter gate still measures freshness against the last *settled* session (yesterday). Today is "negative lag", so **all 2,575 live-priced rows fail the gate** and only the ~254 stale, un-priced rows can match a price/return/volume screen. That is why the same filters produce an entirely different — and wrong — list than ET. In EOD mode the results are internally consistent but are yesterday's settled session, which also can't match ET's intraday screen.

Secondary confirmed gaps:

- **Universe holes.** V-MARC INDIA (`VMARCIND`) exists in `market_stocks` but is flagged `is_active = false` with no company name, so it is never swept and can never appear — ET lists it. Inactive/unnamed rows need reconciliation against the current NSE master.
- **Sweep accounting is wrong.** The promoted sweep wrote 2,575 rows but reports `expected_count = 2,471`, `priced_count = 2,471`, `kotak_count = 2,571`. Expected also drifts sweep to sweep (2,595 → 2,579 → 2,471), so the coverage chip and the "priced / no quote" numbers are not trustworthy.
- **Volume units.** ET prints volume in thousands ('000); the app prints raw shares. Same data, but a hand-copied ET volume threshold silently means 1,000x in our filter.

## The fix

### 1. Make freshness mode-aware (the actual bug)

- In Live mode the reference session is the **promoted sweep's session date**, not the last settled bhavcopy date. Resolve it from the live plane, not by scanning row dates.
- The tech freshness gate keeps rejecting genuinely stale rows, but a row dated *at* the active live session must always pass. Remove the possibility of "row is newer than the reference" ever meaning "not applicable" in Live mode.
- EOD mode is unchanged: settled session, settled columns, no forming bars.
- Rows without a live quote in Live mode are reported as `no quote` (named, as today) instead of quietly becoming the only rows that match.

### 2. Make the mode obvious and correct on arrival

- While the NSE session is open the screener opens in Live mode (already intended) and the status chip states: mode, sweep time, age in minutes, priced/expected coverage.
- Remove the possibility of viewing a "Filters · EOD" screen during market hours without the existing "market open · switch to live" prompt being visible.

### 3. Fix sweep accounting

- Count expected/priced/failed from the same universe snapshot the sweep actually iterated, and record the sweep's true written-row count. The chip and the health panel then agree with `market_live_prices`.
- Investigate and stabilise the drifting expected count (2,595 → 2,471 within 35 minutes) — the universe query used per sweep must be deterministic for a session.

### 4. Universe reconciliation

- Diff `market_stocks` against the current NSE EQ master: reactivate genuinely listed symbols (starting with `VMARCIND`), fill missing company names, and leave true delistings inactive with a reason.
- Surface the count of symbols excluded because they are inactive, so a missing ET name is explainable rather than invisible.

### 5. ET parity check, at one timestamp

- Add a volume unit toggle label (shares / '000) next to the volume filter so an ET-copied threshold is unambiguous.
- Re-run the benchmark screen (Price > 100, MCap > ₹1,000 Cr, 1D Return > 6%, Volume > 30D Avg, ET "raw" volume basis) in Live mode and produce a symbol-by-symbol diff vs ET captured at the same minute, with a named cause for every residual difference.

## Technical notes

- Files involved: `src/lib/market/screenerCatalog.ts` (`resolveReferenceSession`, `rowIsApplicable`), `src/routes/market/Screener.tsx` (reference-session wiring, status chip), `src/lib/market/livePlane.ts` (live session date for Live mode), `supabase/functions/market-live-sweep` (counts, deterministic universe), plus a universe reconciliation pass over `market_stocks`.
- No schema change is required for the core fix; the live plane and view already carry everything needed.
- New tests: live-mode reference session comes from the sweep; a row dated at the live session passes the tech gate; a genuinely stale row still fails; EOD mode keeps settled-date semantics.

## Done when

- With the market open, a Price/1D/Volume screen in Live mode evaluates all ~2,575 priced rows and its results match ET at the same minute, name for name, apart from differences with a stated cause (universe, volume unit, ET's own filters).
