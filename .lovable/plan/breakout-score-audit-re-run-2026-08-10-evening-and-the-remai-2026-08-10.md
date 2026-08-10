# Breakout score — audit re-run (2026-08-10 evening) and the remaining fixes

The August 10 audit landed the model-maths items: `sentiment` is out of the weight table and applies as a bounded multiplier, `delivery_pct` is gone, illiquidity is charged once, breadth has a graded companion (`breadthScore`), and dropped buckets carry a real coverage map. This pass re-checks everything against the live database as of this session and lists only what is still broken.

## What the live data says now

| Signal | Value (2026-08-10) |
|---|---|
| rows in `market_stock_scores` | 2,038 |
| scored (`breakout_score_v4` not null) | 1,668 |
| priced but unscored | **370 (323 on today's session, 206 of them context-complete)** |
| scored rows with `breakout_band` NULL | **21** |
| `market_score_distribution` rows with band cuts | 143 of 148 — **last non-null cut is 2026-07-31** |
| matured 21-day history rows | 603, **all `context_neutral = true`**; live matured: **0** |
| cron job for `market-score-evaluate` | **does not exist** |
| `buckets.sentiment` still written | 1,668 rows, always `0`, coverage `0` |

## Confirmed, still open

**1. `market-score-evaluate` is not scheduled at all.** The cron list has 33 jobs and none of them call it. That single omission explains three separate symptoms: forward returns (`fwd_ret_5d/10d/21d`) are never filled for live rows, so matured live history is zero; `refresh_score_distribution()` never runs, so `strong_cut`/`moderate_cut`/`watch_cut` have been NULL on every session since 2026-08-01; and `stamp_score_history_ranks()` never re-labels history bands.
Fix: add a weekday post-close cron job for `market-score-evaluate`, and backfill the missing sessions once by hand.

**2. Two band systems are live because the cuts are NULL.** The aggregates pass writes `breakout_band` from its own `percentileBandCuts` (STRONG starts at 61 today) but deliberately does not write the cut columns, deferring to `refresh_score_distribution()` — which never runs. `bandOf()` in the UI therefore falls back to the absolute 70/55/40 while the stored band says otherwise. PGIL at 67 is stored STRONG and computed MODERATE by any consumer using the cuts.
Fix: with job (1) restored the cuts appear again; also make the aggregates pass write the same cuts it used for `breakout_band`, so the row is never internally inconsistent even if evaluate is late.

**3. 323 priced rows on today's session have no score and no reason.** Their components blob is `{"buckets": {}, "factors": {}, "penalties": {}}` and `unavailable_reason` is null everywhere. Sampling shows two distinct causes mixed together: rows with `bars_available` NULL (the history gate refuses them) and rows like AEROPLANE with 90 bars, liquid and context-complete, that were refused for a reason nobody recorded.
Fix: persist `unavailableReason` on the row, and report scored / priced / refused-by-reason counts in the aggregates run summary.

**4. 21 scored rows have a NULL band.** `bandFor` only ranks the liquid pool, so illiquid-but-scored rows (scores 0–32) get a score with no band and fall through every band filter.
Fix: band every scored row, or null the score for rows excluded from the pool — don't publish half a verdict.

**5. `sentiment` is still written as a bucket with value 0.** It is no longer in `V4_WEIGHTS`, but the scorer still emits `buckets.sentiment = 0` and `coverage.sentiment = 0` on all 1,668 rows. Any reader that iterates `buckets` (score history panel, snapshots, the optimizer's replay) sees a phantom zero-point bucket.
Fix: stop writing it into `buckets`; keep `sentiment_mult` and the `sentiment.*` factor detail where they belong.

**6. Calibration still fits on a replayed sample.** All 603 matured rows are `context_neutral`; there are zero matured live rows. Any weight or cut derived from this is noise until job (1) has been running for a full 21 sessions.
Fix: show the sample composition (live vs replayed, symbols, sessions) on the Calibration page and refuse to publish a fit that is 100% replayed.

**7. The aggregates pass still swallows phase failures.** Ranking, distribution and history are each wrapped in a bare `catch { /* additive */ }`. A run whose band write threw still reports success.
Fix: record each phase's outcome and surface it on the pipeline health strip.

## Suggested order

1. Item 1 — the cron job, then a manual backfill run. Everything about bands and calibration is downstream of it.
2. Items 2 and 4 — one band definition, every scored row banded.
3. Items 3 and 7 — make refusals and phase failures visible.
4. Item 5 — remove the phantom bucket.
5. Item 6 — only meaningful once live forward returns start maturing.

## Technical notes

- Cron: one migration adding `cron.schedule('market-score-evaluate', ...)` via `market_cron_call`, weekday after `market-pipeline-aggregates` (which runs 15:15 UTC).
- Files: `supabase/functions/market-pipeline-aggregates/index.ts` (band write, distribution upsert, phase reporting, refusal counts), `supabase/functions/_shared/market/scoring.ts` (drop `buckets.sentiment`, persist `unavailableReason`), `src/lib/market/scoreBands.ts`, `src/routes/market/Calibration.tsx`, `src/components/market/ScoreHistoryPanel.tsx`, `src/routes/market/ScoreExplain.tsx`.
- No schema change required; one optional backfill migration if past sessions' cuts are to be recomputed.
