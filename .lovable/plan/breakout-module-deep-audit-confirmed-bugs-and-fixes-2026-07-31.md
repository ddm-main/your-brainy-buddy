# Breakout module — deep audit: confirmed bugs and fixes

Three passes over the module: the v4 scorer, the pipeline/episode lifecycle, and the UI. Every item below is backed by a code read; nothing here is inferred from behaviour alone. Live-data claims from the earlier session are not repeated unless the code confirms them.

## A. Scoring engine (`_shared/market/scoring.ts`, `indicators.ts`)

**A1 — The 120-bar readability gate is skippable.** The guard is `if (bars != null && bars < 120)`. When `barsAvailable` is absent on both the input and the snapshot, the gate does nothing and a 30-bar chart is scored as if fully readable. Fix: refuse to score when bar count is unknown.

**A2 — The pattern bucket claims full coverage when history length is unknown.** `patternsScored = patterns != null && (barsAvailable == null || barsAvailable >= 60)` treats unknown as sufficient — the inverse of its stated intent. Fix: unknown means not scored.

**A3 — Missing turnover means two opposite things.** The volume bucket reads null turnover as liquid and scores it normally; the standalone liquidity gate reads the same null as illiquid and fails it. Fix: one shared helper, unknown = not liquid, and exclude the factor rather than crediting it.

**A4 — The failed-breakout penalty has no recency window.** `computeSnapshot` discards `days` whenever the state is "failed", so the consumer's `(freshnessDays ?? 1) <= 10` is always true. A breakout that failed months ago is penalised as if it failed yesterday. Fix: keep the day count for the failed state and let the 10-day window actually bite.

**A5 — Penalties compose inconsistently.** Five point penalties are subtracted before the regime, fundamentals and coverage multipliers, so a bearish-regime name has its 25-point illiquidity penalty diluted to about 21. The event blackout is applied after all multipliers and is never diluted. Fix: apply all point penalties at the same stage (post-multiplier) so a stated penalty costs what it says.

**A6 — Same-bar pivots need no right-side confirmation.** At the tail of the window `rightBars` collapses to 0, so today's own high can register as a confirmed pivot and then be read as a cleared level. Fix: mark tail pivots provisional and exclude them from the "cleared resistance" set.

**A7 — Unreachable weekly guards.** `barsW <= 0` and `barsW < 3` can never fire because the weekly snapshot is null below 25 weeks. Harmless, but the comments describe handling that does not exist. Fix: delete the dead branches.

**A8 — No test coverage** for the bar gate, the pattern-coverage branch, or the failed-breakout penalty. Fix: add cases for each fix above.

## B. Pipeline and episode lifecycle (`market-pipeline-aggregates`, `market-score-evaluate`)

**B1 — Benchmark-relative returns can be permanently NULL.** The evaluator re-targets rows only where `fwd_ret_21d IS NULL`. The benchmark join is a LEFT JOIN, so if the index bar for that date is missing at the moment absolute returns are stamped, `fwd_rel_*` stays NULL and the row is never revisited. Those rows then silently drop out of the calibration fit and the optimizer. Fix: widen the re-target condition to include rows with an absolute but no relative return, and backfill the index series before evaluating.

**B2 — The whole tracking block is one try/catch.** Snapshots, episode ticks and episode opens share a single handler; one bad row aborts the rest of the run and only writes a generic health log. The rescore loop already does per-item isolation — the tracker should too, with a failure counter in the response.

**B3 — `ignoreDuplicates` freezes a bad entry price.** A same-day re-run cannot correct an episode opened on partial intraday data; the row keeps whichever close qualified first. Fix: allow same-day correction of `entry_close`/`trigger_price` while keeping the detection date fixed.

**B4 — `trigger_price` has no backfill path.** It is `pivotLevel ?? rollingHigh20 ?? null`; a short-history name gets NULL for the episode's whole life even after enough history accumulates. Fix: fill it on the first tick where a level becomes available.

**B5 — Replayed rows never get `rank_pct`.** The backfill hardcodes null, so percentile rank exists only on live rows and mixed-population reads are inconsistent.

**B6 — `evaluated_at` is stamped only when the 21-day return resolves,** so it does not mean "has forward data". Combined with B1, a row can look evaluated while its relative returns are permanently missing. Fix: stamp on any forward fill and add a separate flag for full maturity.

**B7 — No partial-success reporting in `market-score-evaluate`.** Three RPCs run in sequence and any failure returns 500 even though earlier committed work succeeded. Fix: report per-step status.

## C. Frontend (`Breakout.tsx`, `breakoutRun.ts`, `breakoutStage.ts`, score/calibration pages)

**C1 — Weights and thresholds are hand-copied into four places.** `scoreLab.ts` `V4_WEIGHTS`, `scoreExplain.ts` `V4_BUCKETS`, `scoreBands.ts` and the edge scorer all currently agree, and the lifecycle rules in `STATUS_META` are prose copies of `FAIL_PCT`/`EXTEND_PCT`/`COOL_DAYS`/`MAX_TRACK_DAYS`. Nothing enforces any of it. Fix: single shared constants module plus a test asserting the UI copy matches the model constants.

**C2 — Stage derivation manufactures a stage from missing data.** `close: meta.close ?? liveLtp ?? 0` feeds a 0 price into ATR/pivot distance maths and produces a confident EXTENDED or FAILED read; `bbSqueeze`/`nearResistance` default to false and `base_tightness` to 1, indistinguishable from measured values. `NO DATA` only appears when the whole snapshot is null. Fix: return NO DATA when price is missing and mark defaulted inputs.

**C3 — Stage ignores `rollingHigh55`.** The pivot fallback stops at `rollingHigh20`, so a name whose only level is the 55-day high can never read ARMED or TRIGGERED.

**C4 — The Setup column sorts alphabetically,** which has no relation to the coil → armed → triggered progression the tooltip describes. Fix: sort by lifecycle order.

**C5 — The second enrichment query silently drops rows.** It matches on symbol only and skips any row whose exchange key is not already present, so those rows never receive pivot, rolling highs or freshness — and then read COILED or NO SETUP with no indication data was lost. Fix: key both queries on symbol and exchange.

**C6 — Serial fetch waterfall.** Tracker pages are fetched one after another, then two more sequential chunked batches, each chained on the previous. Fix: parallelise the chunks and run the two enrichment batches together.

**C7 — Live ticks are capped at 100 rows silently.** Rows beyond the cap never tick while the header still reads "Live". Fix: either subscribe to the visible rows or state the cap.

**C8 — Threshold chips (0/60/70/80) use a different vocabulary than the score bands (70/55/40)** they are coloured by. Fix: align the chips to real band boundaries, or label them as arbitrary cutoffs.

**C9 — Null sentinels are unexplained.** `rel_volume` sorts as -1, MAE as -Infinity, and the "detected this session" tooltip on a missing health score shows even when the real cause is a pipeline gap. Fix: header-level tooltips and an honest "no data" state.

**C10 — "New today" compares against a client-side IST date** with no fallback to the latest session, so a late pipeline run or a holiday renders an empty tab indistinguishable from "nothing broke out". `daysAgo` also returns 0 on an unparseable date, displaying it as today.

**C11 — Calibration metric abbreviations** (corr, cohort rel, cohort n, hit) have no tooltips.

## Suggested order

1. Scoring correctness A1-A5 with tests (these change every score produced).
2. Pipeline B1-B4 (these corrupt or permanently blank stored rows).
3. UI correctness C2, C3, C5, C10 (wrong values shown today).
4. Shared constants C1 and the remaining presentation items.

## Technical notes

- Touches `supabase/functions/_shared/market/scoring.ts`, `_shared/market/indicators.ts`, `market-pipeline-aggregates/index.ts`, `market-score-evaluate/index.ts`, `market-score-backfill/index.ts`, `src/routes/market/Breakout.tsx`, `src/lib/market/breakoutRun.ts`, `breakoutStage.ts`, `scoreExplain.ts`, `scoreLab.ts`, `scoreBands.ts`, `src/components/market/ScoreWeightsDialog.tsx`, `tests/marketScoring.test.ts`.
- One migration to relax the evaluator's re-target predicate (B1).
- Scoring changes shift historical comparability: after A1-A5 land, stored scores predate the fix, so a re-run of the backfill is needed before any calibration conclusion is drawn.
