# Breakout section — audit findings and rebuild

Verified against the code and live database (9 tracker episodes: 6 active from 2026-07-31, 2 cooled, 1 failed; 9 snapshot rows across 2 days; 13 symbols scored >= 70 today out of 2,927).

## Why "no results / filters not working" happens

1. **Screener filters are inherited silently.** The Breakout page reads the Screener's own localStorage key (`screener.state.v2`) on mount. Any filter left on the Screener page is applied to the tracker with no visible indication that it came from elsewhere.
2. **Filters are evaluated against the wrong row shape.** Tracker episodes are joined to a live screener row only when `exchange === "NSE"` and the symbol is still in the loaded universe. When the join misses, the page builds a synthetic row containing only symbol, exchange, sector, market_cap, close and score. That synthetic row has no `instrument_type` and no `trade_date`, so `rowIsApplicable` rejects it for every `eq`- and `tech`-scoped filter, and `filterMatches` returns false for all technical/fundamental filters. Result: adding almost any filter empties the table.
3. **Boolean and enum filters hard-fail on missing fields.** Any signals filter (BB squeeze, near resistance, pattern flags) drops every tracked row that lacks a matching screener row, because enum/boolean predicates must prove a match.
4. **The tracked universe is genuinely tiny.** Episodes only open at `breakout_score >= 70` **and** the liquidity gate. Today that is 6 new names. With any filter on top, empty results are the normal outcome — the filter rail is the wrong control surface for a 9-row table.

## Decision: drop filtering, rank by score

Remove the entire filter rail and the Screener-state inheritance. The breakout list is already a scored, gated set — it should be presented as a ranked list, sorted by breakout score, with the score front and centre.

## Additional issues found

**Data / pipeline**

- **Entry price is the close of the detection day**, so every day-1 episode shows exactly 0.00% return (confirmed: all six of today's rows are 0). There is no record of the trigger/pivot price, so day-1 follow-through is unmeasurable.
- **Snapshots are written only for qualifiers (>= 70).** Names scoring 60–69 leave no trail, so a stock that approaches the threshold for days and then breaks out has no visible run-up, and the calibration/cohort work has an artificially truncated sample.
- **A name that fails on its detection day is never openable again in the same episode**, and the "New today" view reads only open episodes — a breakout detected today that immediately failed disappears from "New today" entirely.
- **`score_trend` only advances on days the pipeline runs with data**; a skipped session leaves no gap marker, so the sparkline compresses time.
- **Non-NSE episodes can never join a screener row** (the symbol map is NSE-only), so BSE tracking is structurally blind.
- **Default sort is `followthrough_score`**, not the breakout score — the strongest new signal of the day can sit below a stale, well-behaved older episode.

**UI / behaviour**

- The whole screener universe (~2,900 rows, all columns) is fetched on every visit purely to look up company names and LTP for at most a few dozen rows.
- Switching to "All + history" refetches the tracker as a separate query instead of filtering the already-loaded set.
- `initialSort` is fixed at mount; the "New today" label falls back to the last detection date, which can silently show Friday's list titled as today's.
- Status meaning (active / extended / cooled / failed / closed) is never explained anywhere on the page.
- No per-row link into the score explanation, despite `/market/score` now living under Breakout.
- No detection-day context on the row: rel-volume, pivot distance, stage (COILED / ARMED / TRIGGERED / EXTENDED) all exist in the codebase and none surface here.

## What I will build

**1. Remove filtering**
- Delete the filter rail, the `screener.state.v2` inheritance, and all `filterMatches` use from `Breakout.tsx`.
- Table goes full width.

**2. Score-first ranking**
- Default sort: `last_score` descending, then follow-through as tiebreak.
- Add a score-threshold quick control (All / >= 60 / >= 70 / >= 80) as the only narrowing control — a single slider-style chip row, not a filter system.
- Add a plain text search box for symbol/company.
- Score band colouring on the row so strong / moderate / weak is readable at a glance.

**3. Views**
- Keep three views but fix them: **Tracking** (open episodes), **New today** (episodes whose `first_detected_date` is today, including ones that already failed — so this view queries the full set), **All + history**.
- Load the full tracker once and derive all three views client-side.

**4. Row enrichment**
- Add a Stage column driven by the existing `deriveBreakoutStage` logic where the snapshot is available.
- Add rel-volume and days-tracked columns.
- Row menu: open Analysis, open Score explanation, add to watchlist.

**5. Explain the model on the page**
- A collapsible legend describing the qualify threshold (70), the liquidity gate, and each lifecycle status with its trigger rule (fail at -6%, extend at +8%, cool after 3 sub-threshold sessions, close at 15 sessions).

**6. Lighter data path**
- Replace the full `useScreenerData("all")` fetch with a targeted lookup of just the tracked symbols (company name, LTP, rel volume, instrument fields).
- Match the screener row on symbol **and** exchange so non-NSE episodes join correctly.

**7. Pipeline corrections (separate, after the UI lands)**
- Record a `trigger_price` (pivot / prior high) alongside `entry_close` so day-1 return is meaningful.
- Widen snapshot capture to `breakout_score >= 60` so near-misses build history for calibration.
- Let the "New today" set include same-day failures.

## Technical notes

- Files: `src/routes/market/Breakout.tsx` (rewrite), `src/lib/market/breakoutRun.ts` (single full-set query + targeted symbol lookup), no change to `screenerCatalog.ts`.
- Pipeline changes touch `supabase/functions/market-pipeline-aggregates/index.ts` and `supabase/functions/_shared/market/scoring.ts`; the `trigger_price` addition needs one migration adding a nullable column to `market_breakout_tracker`.
- Waves 1–6 are frontend-only and ship first; wave 7 follows once the list is confirmed correct.
