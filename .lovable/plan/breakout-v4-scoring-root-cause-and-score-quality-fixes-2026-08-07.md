# Breakout v4 scoring — root cause and score-quality fixes

I traced the scoring section end to end against the live database. The headline finding is not a maths bug: **the pass that applies market context has been failing on every run since Aug 05**, so most of the model is silently switched off and the UI is faithfully rendering a crippled score.

## What the database actually says (latest session, 2026-08-06, 1,834 rows)

| Signal | Value | Meaning |
|---|---|---|
| `context_complete = true` | 174 / 1,834 (9%) | 91% of the universe scored with neutral context |
| strength bucket covered (≥0.35) | 135 / 1,834 (7%) | the 13-pt strength bucket is dropped for 93% of stocks |
| sentiment bucket covered | **0 / 1,834** | the 9-pt sentiment bucket has never been scored, for anyone |
| `breakout_band` populated | **0 / 1,834** | the band column is never written |
| `rel_strength_nifty` present | 1,560 | the data exists — it just arrived after scoring and nothing re-scored |
| newest `market_score_history` row | 2026-08-04 | history has been frozen for 2 sessions |

Orchestrator log, 2026-08-07 08:51:28:

```text
market-pipeline-aggregates → HTTP 500:
{"error":"column market_stock_scores.raw_buckets does not exist"}
```

`raw_buckets` is a column on `market_score_history`, not on `market_stock_scores`. The repo source of `market-pipeline-aggregates` does not reference it against that table, so the **deployed** copy has drifted from the source. That single 500 explains almost everything above: aggregates is the only pass that writes sector strength, relative strength, RS percentile, rank percentiles, the band distribution and the score-history snapshot — and it dies before any of them.

## Consequences that show up as "wrong scores"

1. **Strength dropped, weight redistributed.** Only `pos_52w` is available at EOD time, giving the bucket coverage 0.25 against a 0.35 floor, so `rollup()` returns null and 13 points are erased. The remaining buckets are scaled up by `100/weightHave`, so a stock that is technically fine but has no context reads as if it earned a full-model score.
2. **Sentiment is permanently dead weight.** Neither pipeline pass ever supplies `sentiment` to `breakoutScoreV4`, so its 9 points are renormalised away for every symbol on every session. The model advertises 100 points and has only ever scored 91 — and the renormalisation quietly inflates the rest.
3. **Renormalisation has no cap.** With strength and sentiment both dark, 22% of the model is redistributed. `MIN_TOTAL_COVERAGE` is the only guard and it is far below that. A 78%-coverage score is presented as equivalent to a 100%-coverage score.
4. **`market_rescore_prices_batch` publishes stale scores under a new date.** The SQL rescorer advances `trade_date`, `close`, `rel_volume` and the moving averages for ~1,800 rows but never touches `breakout_score_v4`, `breakout_v4_components`, `breakout_v4_coverage` or the context columns. Yesterday's score is re-labelled as today's. It also writes **SMA** values into the `ema20/50/100/200` columns, which the scorer then reads as EMAs — the trend bucket is being fed the wrong indicator for every row this function touches.
5. **Bands are computed twice and stored never.** `breakout_band` is NULL universe-wide and `market_score_distribution` has not been refreshed since aggregates broke, so the calibrated cuts the UI reads are stale and every band label falls back to fixed thresholds.

## Fix plan

**A. Unbreak the context pass (highest impact, unblocks everything else)**
- Redeploy `market-pipeline-aggregates` from source to clear the stale `raw_buckets` reference, then run it once for 2026-08-06 and confirm `context_complete`, `strength` coverage and `market_score_history` all move.
- Add a guard so a failed aggregates run is loud: record the failure on `market_ingestion_runs` with `status = failed` *and* surface it on the pipeline health strip, instead of only living in a metadata blob nobody reads.
- Backfill the two lost sessions (08-05, 08-06) of `market_score_history`.

**B. Make the EOD → aggregates handoff correct**
- After aggregates writes `sector_strength` / `rel_strength_nifty` / `rs_percentile`, re-run `breakoutScoreV4` for that row and write score, buckets, coverage, penalties **and** `breakout_band` in the same update. Today it writes context columns and leaves the neutral-context score in place.
- Write `breakout_band` (uppercase, from the calibrated cuts) in both passes so the UI never has to derive it.

**C. Stop the SQL rescorer from lying**
- `market_rescore_prices_batch` must either (a) null out `breakout_score_v4`, its components/coverage and the context columns and set `context_complete = false` when it advances `trade_date`, so the row reads as "priced, not yet scored", or (b) not advance `trade_date` at all. Option (a) is the smaller change and matches how the UI already handles a missing score.
- Rename the SMA columns it populates, or compute true EMAs. Writing SMA into `ema*` is a silent accuracy bug for every scored row.

**D. Scoring-model corrections**
- **Wire sentiment in or remove its weight.** Either feed `market_stock_ai` / `market_news` into the scorer's `sentiment` input, or drop the bucket from `V4_WEIGHTS` and redistribute its 9 points explicitly. A bucket that is never covered should not exist in the published weight table.
- **Cap renormalisation.** Below ~85% covered weight, stop scaling the surviving buckets to 100 and instead publish the score against its real ceiling, with `coverage_share` shown next to it. This removes the current systematic upward bias on thin names.
- **Charge unknown context as neutral, not absent, for `breadth`.** With regime null the factor drops out; treating it as 0.5 keeps the bucket alive and is what the neutral-context pass already means.
- Extend `tests/v4-weights.test.ts` with a coverage-invariant test: for a fixed input, a dropped bucket must never increase the score relative to the same input with that bucket scored at its own average.

**E. UI honesty (small, follows from the above)**
- Show `coverage_share` on the A3 breakdown and in the screener tooltip, so a 78%-coverage score is visibly different from a full one.
- Show a "scores stale — context pass failed" banner when the newest `market_score_history` date lags the newest `market_stock_scores` date by more than one session.

## Technical notes

- Files: `supabase/functions/market-pipeline-aggregates/index.ts` (redeploy, band write, re-score after context), `supabase/functions/market-pipeline-eod/index.ts` (handoff), `supabase/functions/_shared/market/scoring.ts` (`rollup`, renormalisation cap, sentiment wiring, breadth neutral), `src/lib/market/scoreExplain.ts` and `src/components/market/ScoreHistoryPanel.tsx` (coverage share, stale banner), `tests/v4-weights.test.ts`.
- Database: one migration to replace `market_rescore_prices_batch`. No schema change is needed — `breakout_band`, `breakout_v4_coverage` and `context_complete` all already exist.
- Order matters: A must land and be verified before B–D can be measured, because today every score in the table was produced by the broken path.
