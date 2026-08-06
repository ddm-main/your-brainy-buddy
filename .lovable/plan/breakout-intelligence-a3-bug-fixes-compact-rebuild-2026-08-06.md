# Breakout Intelligence (A3) — bug fixes + compact rebuild

Deep check of the A3 panel on `/market/analysis/:symbol` (score row, AI adjustment line, news line, stage detail, and the EOD score-history block), verified against the live database for FIEMIND.

## Bugs found (verified)

1. **Three different scores on one screen, none of them labelled as vintages.**
   Panel shows `66` (live), `raw 61`, and `39` (EOD Aug 04) — while `market_stock_scores` for FIEMIND on 2026-08-05 holds `breakout_score_v4 = 43` and `breakout_score = 37`. Four numbers for one concept, no explanation of which is which.

2. **Score history is a day behind the scores table.**
   `market_score_history` max date is 2026-08-04 with only 747 rows that day (a full day is ~1,500), while `market_stock_scores` is already on 2026-08-05. The panel therefore shows "Aug 04 · behind" rather than the current session.

3. **`breakout_band` is NULL on the live score row** (confirmed for 2026-08-05) while the history row says `weak`. The band chip appears next to the EOD number and vanishes from the live number — it looks like a rendering bug.

4. **1,100 `market_score_history` rows store the wrong shape.**
   Those rows put the whole components object (`{buckets, factors, penalties}`) into the `buckets` column instead of just the bucket points, so `buildBucketRows` reads `0.0` for every bucket while the score reads e.g. 26. FIEMIND's rows are fine, so this hits other symbols' panels and `/market/score/:symbol/explain`.

5. **Score clamps to 0.** `Math.max(0, raw + aiAdj)` turns raw 3 with AI −5 into a flat `0`, which is indistinguishable from "not scoreable".

6. **Unwanted / duplicated text.** Three stacked right-aligned micro-lines (AI adjustment reason, news sentiment, stage detail); news sentiment is already shown in the AI Verdict panel above. `"Last EOD score"` duplicates the date chip. `"42.8 earned · 57.2 not earned, out of 100"` is a sentence where a number belongs — and is wrong whenever bug 4 applies.

7. **Dead rows eat height.** Buckets with `part. data` / `no data` (sentiment here) still render a full-width empty bar row each.

## Fixes

**Correctness**
- Unwrap defensively in `buildBucketRows`: if the object has a `buckets` key holding an object, use that. Fixes the panel and the explain page for the 1,100 bad rows with no migration.
- One-off migration to repair those rows (`buckets = buckets->'buckets'`, fill penalties/raw buckets from the same blob).
- When the newest history row is older than the newest score row, fall back to `market_stock_scores.breakout_v4_components.buckets` + `score_coverage` so the panel shows the current session.
- Derive the band locally via `bandOf(score)` whenever `breakout_band` is NULL, so the chip never disappears.
- Stop clamping to 0: floor the AI-adjusted score at 1 when the raw score is > 0; keep "not scoreable" for a genuinely missing score.

**Compact view (panel shrinks to roughly half its height)**
- One score line: big number + band chip + stage chip + AI delta chip + a single vintage chip (`live` / `EOD Aug 05`) — no second score block.
- Collapse the three micro-lines into one muted line, one clause each; drop news sentiment here.
- Replace the earned/not-earned sentence with the stacked bar plus a compact `39 / 100` caption.
- Bucket rows in a two-column grid (7 rows become 4 lines); buckets with no data collapse into one trailing `no data: sentiment` line.
- Move "More Details →" from a full-width button to a small link in the panel header, next to the vintage chip.
- Remove the "Last EOD score" heading — the vintage chip already says it.

Nothing is lost: `/market/score/:symbol/explain` keeps every detail removed from the panel.

## Technical notes

Files: `src/components/market/ScoreHistoryPanel.tsx` (compact rewrite), `src/lib/market/scoreExplain.ts` (`buildBucketRows` unwrap), `src/routes/market/Analysis.tsx` (A3 block: single score line, merged detail line, header action), plus one repair migration for `market_score_history`. No scoring-engine changes.
