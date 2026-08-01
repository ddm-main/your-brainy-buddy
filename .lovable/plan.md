# Breakout score: how it works, what is broken, and the fix

## How the score is produced today (verified in code + data)

1. `market-pipeline-eod` stores per-symbol indicator/price state in `market_stock_scores`.
2. `market-pipeline-aggregates` computes breadth, sector strength and relative strength, then calls `breakoutScoreV4` (in `supabase/functions/_shared/market/scoring.ts`) per symbol.
   - Seven buckets with raw weights summing to 100: levels 22, volume 16, indicators 16, setups 13, strength 13, patterns 11, sentiment 9.
   - Each bucket rolls up weighted 0–1 sub-factors; a bucket with under 35% sub-factor coverage is dropped and its weight is redistributed over the covered buckets (`scale = 100 / weightHave`).
   - Gates: under 120 bars, or under 45% of total weight covered, returns `score: null` with a reason.
   - Then `raw x regime_mult x fundamental_mult x coverage_mult`, minus point penalties (overextension, thin volume, overbought, bearish pattern, failed breakout, illiquid 25), then an event-blackout cap.
   - Written to `market_stock_scores.breakout_score_v4` + `breakout_v4_components` and snapshotted into `market_score_history` (score, band, rank_pct, buckets, coverage, raw_buckets).
3. `market-score-evaluate` (nightly) runs `evaluate_score_history_forward` (fills fwd 5/10/21d absolute and NIFTY-relative returns), `fit_score_calibration` (regresses forward return on score and on each bucket), `refresh_score_distribution` (per-day percentile cut-offs).
4. `market-score-backfill` replays history for context-neutral rows; `market-score-optimize` replays stored buckets under alternative weights for the Calibration Lab.

## Confirmed bugs (each verified against the live database or the source)

1. **`raw_buckets` is NULL on all 7,263 history rows** — including the 4,906 live rows written after the column was added. The aggregates upsert swallows its error (`if (!error) history.written += ...`), so either the write is failing silently or the deployed function predates the field. The optimizer's exact replay path therefore never runs; it falls back to inverting renormalised points, which cannot recover penalties.
2. **Two different band-cut definitions fight over the same row.** Aggregates writes `strong/moderate/watch_cut` from `percentileBandCuts` (top 2% / 10% / 25%), and `refresh_score_distribution` then overwrites the same columns with p90 / p70 / p50. Live data shows `strong_cut = p90` on every row — the aggregates values are always discarded.
3. **Percentile cut-offs are computed but never used.** `band` in `market_score_history`, `ScoreBadge`, `Breakout`, `ScoreDetail` and the AI prompt all use fixed 70/55/40. The observed maximum score across the universe is 71 (p90 = 51), so "STRONG" is effectively unreachable and the whole app reads WEAK/WATCH.
4. **Calibration cannot ever fit.** `fit_score_calibration` needs 60 distinct symbols; the only matured population is the backfill (38 symbols, 28 matured), so the current calibration row is literally `coverage:insufficient population=replayed_neutral symbols=19 sessions=122`. Live rows exist for only 2 sessions and mature in 21.
5. **Bucket attribution regresses on renormalised points.** `bucket:<key>` slopes are fitted on `buckets` values, whose scale changes with each row's coverage — the same underlying quality yields different point values, injecting coverage noise into every bucket slope.
6. **`evaluate_score_history_forward` uses calendar-lead on daily rows.** `lead(c,5)` counts stored bars, so a symbol with holes in `market_daily_prices` gets a longer-than-5-session return labelled 5d, and the benchmark leg is joined by date only, not by matched bar count.
7. **Distribution mixes populations.** `refresh_score_distribution` treats `COALESCE(is_liquid_tradable, true)` as liquid, so backfill rows with a NULL flag land in the same percentiles as the live liquid universe (n jumps 22 → 2,468 → 1,419 across adjacent sessions).
8. **`fit_score_calibration` silently switches populations** to `replayed_neutral` while writing rows the UI shows the same way as a live fit; only one marker row names the population.
9. **Backfill rows lack `rank_pct` and `is_liquid_tradable`**, so any query filtering on those quietly drops the entire replayed history.
10. **Coverage haircut is double counting.** Missing weight is first redistributed to the present buckets and then penalised again by `coverage_mult` (0.9–1.0), so thin-coverage names are charged twice for the same gap.
11. **Score bands in the UI mirror the scorer manually** (`src/lib/market/scoreBands.ts` vs `scoring.ts`); only the v4 weights are cross-checked by a test.

## The fix

**A. Make the evidence layer trustworthy**

- Stop swallowing the `market_score_history` upsert error in aggregates; count failures and surface the first message in the run result (same pattern already used for the rescore loop).
- Verify `raw_buckets` lands after redeploy; backfill it for existing live rows by recomputing raw values from `buckets`, `coverage`, `score` and stored penalty detail where possible, and stamp `is_liquid_tradable` / `rank_pct` on backfill rows.
- Rewrite `evaluate_score_history_forward` to lead over *session index per symbol* with an explicit bar-count check, and to compute the benchmark leg over the same number of benchmark sessions rather than by raw date join.

**B. One band system**

- Make percentile cuts the single source of truth: `refresh_score_distribution` keeps the percentile columns, and the `strong/moderate/watch_cut` columns are written from one definition only (p98 / p90 / p75, matching `percentileBandCuts`). Remove the competing write from aggregates.
- Band assignment in `market_score_history` and in the UI reads the day's cut-offs, falling back to the absolute 70/55/40 only when no distribution row exists. Keep the absolute constants for AutoTrade/alerts entry rules so trading behaviour does not change silently.
- Add a test asserting `scoreBands.ts` matches `scoring.ts`, next to the existing v4 weight test.

**C. Fix the calibration fit**

- Fit bucket slopes on the *raw* 0–1 bucket values (from `raw_buckets`, else reconstructed), not renormalised points, so coverage does not enter the regression.
- Restrict the distribution and the fit to one explicit population: liquid rows with a non-NULL flag, and treat `context_neutral` rows as a separate, clearly labelled population everywhere (`population:` marker already exists — surface it in the Calibration UI as a banner, not a row).
- Lower the symbol floor only in combination with a widened backfill: extend `market-score-backfill` coverage from 38 to a few hundred liquid symbols so a real fit becomes possible, and report expected maturity date in the run response.

**D. Scoring corrections**

- Drop the double charge: keep either redistribution + no haircut, or no redistribution; the plan keeps redistribution and removes `coverage_mult`, recording the coverage share as metadata only.
- Surface the population and coverage caveats in `ScoreExplain` so a thin score reads as thin without being silently discounted.

**E. Improvements listed, not silently applied**

- Persist per-run scorer version so a weight change invalidates comparisons instead of mixing model generations under one `breakout_v4` label.
- Add a nightly self-check row (rows written, raw_buckets non-null share, matured count, fit population) so a broken loop is visible instead of appearing as "insufficient".

## Technical notes

Files touched: `supabase/functions/_shared/market/scoring.ts`, `supabase/functions/market-pipeline-aggregates/index.ts`, `supabase/functions/market-score-backfill/index.ts`, `supabase/functions/market-score-evaluate/index.ts`, `supabase/functions/market-score-optimize/index.ts`, `src/lib/market/scoreBands.ts`, `src/lib/market/scoreHistory.ts`, `src/routes/market/Calibration.tsx`, `src/routes/market/ScoreExplain.tsx`, plus one migration replacing `evaluate_score_history_forward`, `fit_score_calibration` and `refresh_score_distribution`, and a data backfill for `is_liquid_tradable` / `rank_pct` on replayed rows. Edge functions redeployed at the end.
