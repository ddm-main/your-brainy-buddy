# Breakout panel cleanup + a real "Score Explained" page

## What's wrong today

The Breakout Intelligence rail stacks two different score systems on top of each other, so it reads as noise:

- **Two conflicting scores under the same name.** The panel shows `Breakout Score 51` (today's live/EOD score from the screener row) and, a few lines below, `Breakout Score 37 · WEAK · Jul 30` from the nightly snapshot table. Same label, different number, no indication of which one matters.
- **"no snapshot"** — a loading placeholder is rendered as if it were a verdict.
- **Universe Rank / Coverage rows** are internal telemetry, not decisions.
- **"Coverage 6 of 7 buckets · levels, setups, volume, patterns, strength, indicators"** is an unreadable comma dump.
- **Three stacked link buttons** (Score history, Forward returns, Model calibration lab) push useful content off screen.
- **The bar chart hides the real total.** Buckets are shown against renormalised ceilings (`levels 2.2 / 24.2`), so the seven rows never visibly add to 100 and the redistributed weight of the missing bucket is invisible.
- **No "why".** `levels 2.2 / 24.2` never says that the trigger sub-factor scored near zero because price sits below the pivot — the only thing worth knowing.

## The fix

### 1. Compact the rail panel

Keep only, in one tight block:

- One score number + band chip + as-of date, with a single line stating which score it is (live intraday vs last EOD snapshot) instead of two rival numbers.
- A single 100-point distribution bar: seven stacked segments (earned points per bucket) plus a greyed "not covered / redistributed" segment, so it always visually sums to 100.
- Seven compact rows: bucket, earned points, raw weight, thin bar.
- One button: **More Details →**.

Remove: Universe Rank row, Coverage text row, the "no snapshot" placeholder, the redistribution footnote, and the three link buttons.

### 2. New page: `/market/score/:symbol/explain`

Full-width, dense, evidence-only. Sections:

- **Header** — symbol, score, band, as-of date, close, liquidity/context flags, link back to the chart.
- **Distribution of 100** — full-width stacked bar plus a table: bucket | raw weight | renormalised ceiling | earned | % of ceiling. A footer row proves earned + unearned + penalties = final score.
- **Per-bucket breakdown** — one card per bucket, expanded from the stored `breakout_v4_components.factors` (keys like `levels.trigger`, `levels.base_tightness`). Each sub-factor shows its weight inside the bucket, its 0–1 value, the points contributed, and a plain-English sentence derived from the underlying metric.
  Example for the case on screen: *"levels earned 2.2 of 24.2. trigger (45% of the bucket) scored 0.02 — close is ~0.9 ATR below the 20-day pivot, so there is no breakout trigger; base_tightness 0.61 and base_duration 0.40 carried most of what was earned; support_defence 0.30 — price is not sitting on a defended support."*
- **Penalties** — each applied penalty, its point cost, and why (from stored `penalties`).
- **Fundamental multiplier** — value and the sub-factors behind it, stated as a multiplier, not points.
- **Missing data** — buckets below the 0.35 coverage threshold, which input is missing, and how much weight was redistributed.
- **Scoring criteria reference** — a static, always-visible section documenting every bucket and sub-factor: what it measures, its weight, and what full credit looks like. This is the "deeply explain the scoring criteria" part and does not depend on data being present.
- **Footer links** — score history, forward returns, calibration lab (moved off the rail to here).

### 3. Bugs fixed along the way

1. Two different "Breakout Score" values shown at once with no distinction — resolved by labelling the source and showing one primary number.
2. `deriveBreakoutStage` returns `LOADING / "no snapshot"` and the rail renders that detail string as analysis — suppressed while loading.
3. Bucket ceilings are renormalised while the panel implies a 100-point scale — the new distribution bar shows raw weight, earned, and redistributed explicitly.
4. Buckets with `coverage > 0` but below the 0.35 present-threshold render as `0.0 / 0.0` in warn colour despite contributing — shown as partially covered instead.
5. Buckets are sorted by points, so rows reshuffle between sessions — fixed order, raw weight descending.
6. The rail's `ScoreBadge` navigates to `/market/ai/:symbol` (AI engine) rather than the score explanation — repointed at the new explain page.

## Technical notes

- No schema or edge-function change needed. `market_stock_scores.breakout_v4_components` already stores `{ buckets, factors, penalties }` (written by `market-pipeline-aggregates`) and `useStockScores` selects `*`. `market_score_history` supplies snapshot buckets/coverage.
- New shared module `src/lib/market/scoreExplain.ts`: the v4 bucket/sub-factor catalog (weight, label, description, full-credit definition) mirrored from `supabase/functions/_shared/market/scoring.ts`, plus helpers turning `factors` and snapshot metrics into the per-factor sentences.
- New route `score/:symbol/explain` in `src/routes/Market.tsx`; page at `src/routes/market/ScoreExplain.tsx`.
- `src/components/market/ScoreHistoryPanel.tsx` becomes the compact rail block; `src/routes/market/Analysis.tsx` drops the Universe Rank and Coverage rows.
- The existing `/market/score/:symbol` history page stays as-is and is linked from the new page.