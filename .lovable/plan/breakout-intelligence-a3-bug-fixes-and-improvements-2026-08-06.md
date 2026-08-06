# Breakout Intelligence (A3) — bug fixes and improvements

Logged in as msdeepakdon@gmail.com and loaded `/market/analysis/GREENLAM` live, then cross-checked the numbers against the database. The panel is showing two different scores for the same stock and three buckets that are silently dropped are being drawn as hard zeros. Findings below are all verified against the live page and the stored rows.

## What is actually wrong

**1. The stock's stored score is understated — context was never folded in.**
The 2026-08-05 row has `rel_strength_nifty 7.66`, `rs_percentile 69.2`, `sector_strength 0.67` all populated, yet its coverage map says `strength: 0.25`, which is under the 0.35 minimum, so the whole 13-point strength bucket was dropped and stored as `0`. The previous day's history row scored strength `8.8` with coverage `1`. The score row was written by the neutral-context pass before the context columns landed and was never re-scored afterwards. Net effect: 36/WEAK instead of roughly mid-40s/MODERATE.

**2. Dropped buckets are drawn as "0.0 / weight" — they read as "scored zero".**
`ScoreHistoryPanel` derives coverage from the bucket values themselves (any finite number, including `0`, is treated as fully covered). So `strength 0.0/13`, `patterns 0.0/11`, `sentiment 0.0/9` appear as earned-nothing rows, the "no data: …" footer never renders, and the denominators shown are the raw weights (summing to 100) instead of the renormalised ceilings the score actually used. That is why "37 earned" sits next to a score of 36 out of a real ceiling of ~67.
The correct coverage already exists in `market_stock_scores.breakout_v4_coverage` and `market_score_history.coverage`; the panel just is not given it.

**3. Two scores, no explanation.** The panel prints a live `63 MODERATE` and directly underneath `36 / 100 WEAK EOD`. Both are correct for their own inputs (live re-runs v4 on the repriced bar with a different covered-bucket set), but nothing tells the reader they are different vintages of the same number, and the sub-factor grid below belongs only to the EOD one.

**4. Band labels disagree with the badge.** The `ScoreBadge` colours the number using calibrated percentile cuts (`useScoreBandCuts`), while the MODERATE/WEAK chip next to it uses `bandOf()` with no cuts. They can and do disagree. `breakout_band` is also NULL on the score row, and history stores lowercase (`weak`) while the fallback path stores uppercase — the chip flips case between vintages.

**5. Volume bucket contradicts the rest of the page.** `rel_volume` is `8.07` and the AI verdict says "high relative volume", but the stored factor `volume.rel_volume_30d` is `0` and the bucket earns `4.4/16` with a `thin_volume: 0.9` penalty. The relative-volume leg is being zeroed by the turnover floor; that needs to be surfaced (or fixed) rather than silently contradicting the panel above it.

**6. `sessionOpen` is not reactive.** A3 gates live/EOD on `marketOpen()` evaluated during render, while the same file already has the reactive `useMarketOpen()` (used only for depth). At 09:15 and 15:30 the panel keeps the wrong vintage until something else re-renders.

**7. Score history is stale and short.** The history table's newest row is 2026-08-04 while the scores table is on 08-05, so the panel silently switches to the fallback path with a different shape of data (no real coverage). The panel also renders `loading…` as bare text, causing a layout jump on every symbol change.

**8. Runtime error on the page.** `Object is disposed` fires from the chart shell — a lightweight-charts series is being touched after `remove()` during teardown/fullscreen transitions.

## Fix plan

**Data correctness (backend)**
- Re-score rows whose context columns are populated but whose `breakout_v4_coverage.strength` is below the minimum, so the strength bucket stops being dropped; make the context pass re-run v4 after it writes `rel_strength_nifty` / `rs_percentile` / `sector_strength` instead of leaving the neutral score in place.
- Backfill/repair `breakout_band` on `market_stock_scores` and normalise band casing to uppercase at read time.
- Have the score-history writer catch up to the latest scored session so A3 stops needing the fallback path day to day.

**Panel (A3 / ScoreHistoryPanel)**
- Pass the real coverage map (`breakout_v4_coverage`) into the panel; use it, not the presence of a number, to decide `present`. Dropped buckets move out of the grid into the "no data: strength, patterns, sentiment" footer.
- Show the renormalised ceiling as the denominator (e.g. `12.1 / 28.2`) and label the total as `earned of <ceiling> available`, so the total reconciles with the score.
- Add a compact vintage header: `LIVE 63` with `EOD 36 (Aug 05)` as an explicit secondary line, and mark the bucket grid as "EOD breakdown" so it is clear which number it explains.
- Single source of truth for the band: derive it once with the calibrated cuts and use that for both badge colour and chip text.
- Show the penalty line (`thin volume −0.9`) and a one-line note when a factor is floored (relative volume zeroed by the turnover floor), so the panel never contradicts the AI verdict silently.
- Skeleton placeholder instead of `loading…`; keep panel height stable.
- Switch A3 to the reactive `useMarketOpen()` so live/EOD flips at the bell.

**Chart**
- Guard the chart teardown path so no series/primitive is accessed after disposal, clearing the `Object is disposed` runtime error.

## Technical notes

- Files: `src/routes/market/Analysis.tsx` (A3 block, `sessionOpen`), `src/components/market/ScoreHistoryPanel.tsx` (`fromComponents`, denominators, footer), `src/lib/market/scoreExplain.ts` (`buildBucketRows` ceilings), `src/components/market/ScoreBadge.tsx` (shared band), `src/lib/market/hooks.ts` (select `breakout_v4_coverage`), `src/components/market/FullscreenShell.tsx` / `CandleChart.tsx` (disposal guard).
- Backend: the v4 engine in `supabase/functions/_shared/market/scoring.ts` is correct — the bug is the ordering of the EOD passes, not the maths. Re-score is a targeted pass over rows with context present and strength coverage below `BUCKET_MIN_COVERAGE`.
- No schema change is required; `breakout_v4_coverage` and `market_score_history.coverage` already exist.
