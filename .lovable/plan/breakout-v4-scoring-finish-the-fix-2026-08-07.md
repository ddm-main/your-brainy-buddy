# Breakout v4 scoring — finish the fix

I re-checked the live database and the repo before writing this. Some of the earlier plan is already in the source; none of it has reached the data.

## Verified current state (2026-08-07)

| Signal | Live value |
|---|---|
| latest session `market_stock_scores` | 2026-08-06, 1,834 rows |
| `context_complete = true` | 174 / 1,834 (9%) |
| `breakout_band` populated | 0 / 1,834 |
| `rel_strength_nifty` present | 1,560 (data exists, nothing re-scored) |
| newest `market_score_history` | 2026-08-04 (frozen 2 sessions) |

Already present in the repo source, so not the cause: the renormalisation cap (`V4_FULL_RENORM_COVERAGE = 0.85`), the sentiment input wired from `market_news` inside the aggregates pass, the `breakout_band` write in aggregates, and the coverage-invariant tests in `tests/v4-weights.test.ts`.

The remaining defect is deployment and handoff, not model maths: the deployed `market-pipeline-aggregates` is an older build that fails with `column market_stock_scores.raw_buckets does not exist`, so none of the above ever executes.

## Work to do

**1. Redeploy and re-run the context pass**
- Deploy `market-pipeline-aggregates` from current source.
- Run it for 2026-08-06, then 2026-08-05, and confirm `context_complete`, `breakout_band` and `market_score_history` all move.
- Backfill the two missing `market_score_history` sessions and refresh `market_score_distribution` so the calibrated band cuts are current again.

**2. Make a failed pass loud**
- `market_ingestion_runs` has `status` / `error_message`; aggregates currently only leaves the failure in `metadata`. Write a `failed` row with the error text on any non-2xx or thrown path.
- Surface the newest failed run on the pipeline health strip instead of it living in a blob nobody reads.

**3. Re-score after context lands**
- After aggregates writes `sector_strength` / `rel_strength_nifty` / `rs_percentile`, re-run `breakoutScoreV4` for that row and write score, buckets, coverage, penalties and band in the same update — today the context columns are updated but the neutral-context score is left in place.
- Stop `market-pipeline-eod` from writing `breakout_band: null`; leave the prior band until aggregates recomputes it.

**4. Stop the SQL rescorer from publishing stale scores**
- One migration replacing `market_rescore_prices_batch`: when it advances `trade_date`, null `breakout_score_v4`, its components/coverage and the context columns and set `context_complete = false`, so the row reads as "priced, not yet scored".
- It writes SMA values into the `ema20/50/100/200` columns; compute true EMAs there so the trend bucket is not fed the wrong indicator.

**5. Model corrections still outstanding**
- Treat unknown regime as neutral (0.5) for `breadth` rather than dropping the factor, matching what the neutral-context pass already means.
- Add a test that a dropped bucket can never raise the score versus the same input with that bucket scored at its own average.

**6. UI honesty**
- Show coverage share next to the score on the A3 breakdown and in the screener tooltip, so a 78%-coverage score is visibly different from a full one.
- Banner on the score panels when the newest `market_score_history` date lags the newest `market_stock_scores` date by more than one session.

## Technical notes

- Files: `supabase/functions/market-pipeline-aggregates/index.ts`, `supabase/functions/market-pipeline-eod/index.ts`, `supabase/functions/_shared/market/scoring.ts`, `src/lib/market/scoreExplain.ts`, `src/components/market/ScoreHistoryPanel.tsx`, `src/components/market/ScoreBadge.tsx`, `tests/v4-weights.test.ts`.
- Database: one migration for `market_rescore_prices_batch`. No schema change — `breakout_band`, `breakout_v4_coverage`, `context_complete` all exist.
- Order matters: step 1 must land and be verified first, since every score currently in the table came from the broken path.