# Breakout Intelligence panel — bug fixes + compact rebuild

Deep check of the A3 "Breakout Intelligence" panel on `/market/analysis/:symbol` (score row + AI adjustment + news line + stage detail + EOD score history block).

## Bugs found (verified against the database)

1. **Bucket bars read 0.0 for every bucket (`levels 0.0 / 22`, `volume 0.0 / 16`, …).**
   Verified: 1,100 of the 1,161 `market_score_history` rows written on 2026-08-03 store the *whole* components object (`{buckets, factors, penalties}`) in the `buckets` column instead of just the bucket points. `buildBucketRows` looks up `pts["levels"]` and finds nothing, so it prints 0.0 while the score says 26. Every other session's rows are shaped correctly, so this is one bad write, not a scorer bug.

2. **Score history is stale / "behind".**
   Verified: `market_score_history` max date is 2026-08-04 (and only 747 rows that day vs ~1,500 on a full day), while `market_stock_scores` already holds 2026-08-05. UEL's newest history row is 2026-08-03 — hence "Aug 03 · behind".

3. **Three different scores on one screen.**
   Live badge shows 0, the line under it says "raw 3", the EOD block says 26, and `market_stock_scores.breakout_score_v4` for UEL on 2026-08-05 is 10 (with `breakout_score` 37). The panel never says these are different vintages of the same number, so it reads as broken.

4. **Score clamps to 0 and hides the AI penalty.** `max(0, raw + aiAdj)` turns raw 3 with AI −5 into a flat 0 — indistinguishable from "not scoreable".

5. **`breakout_band` is NULL on the live row** while the history row has `weak`, so the band chip appears/disappears depending on which vintage is displayed.

6. **Duplicate / low-value text.** The AI adjustment reason, news-sentiment line and stage detail render as three stacked right-aligned micro-lines; news sentiment is already shown in the AI verdict panel above.

7. **`0.0 earned · 100.0 not earned, out of 100`** is a sentence where a number belongs, and it is wrong whenever bug 1 applies.

8. **"part. data" / "no data"** rows still render a full-width empty bar row each, eating vertical space for buckets that contributed nothing.

## Fixes

**Data correctness**
- Unwrap defensively in `buildBucketRows`: if the passed object has a `buckets` key holding an object, use that instead. Fixes the panel *and* `/market/score/:symbol/explain` for the 1,100 bad rows without a migration.
- One-off SQL migration to repair the 2026-08-03 rows: set `buckets = buckets->'buckets'`, and fill `raw_buckets`/penalties from the same blob where missing.
- Fall back to `market_stock_scores.breakout_v4_components.buckets` + `coverage` when the newest history row is older than the newest score row, so the panel shows the current session instead of a stale one.
- Derive the band locally (`bandOf(score)`) whenever `breakout_band` is NULL, so the chip never vanishes.
- Stop clamping the AI-adjusted score to 0: show the adjusted value with a floor of 1 when the raw score is > 0, and keep "not scoreable" reserved for a genuinely missing score.

**Compact view (the panel shrinks to roughly half its current height)**
- One score line: big number + band chip + stage chip + AI delta chip, with `live` / `EOD Aug 05` as a single vintage chip instead of two separate score blocks.
- Collapse the three right-aligned micro-lines into one muted line, at most one clause each, and drop the news-sentiment line here (it already lives in the AI verdict panel).
- Replace the "earned / not earned" sentence with the stacked bar plus a compact `26 / 100` caption.
- Bucket rows: two-column grid, 7 rows become 4 lines; buckets with no data collapse into one trailing `no data: strength, sentiment` line.
- Drop the full-width "More Details →" button in favour of a small link-style action in the panel header, next to the vintage chip.
- Remove the "Last EOD score" heading — the vintage chip already says it.

## Technical notes

Files touched: `src/components/market/ScoreHistoryPanel.tsx` (rewrite, compact), `src/lib/market/scoreExplain.ts` (`buildBucketRows` unwrap), `src/routes/market/Analysis.tsx` (A3 block: single score line, merged detail line, header action), plus one repair migration for `market_score_history`. `/market/score/:symbol/explain` keeps every detail that is removed from the panel.
