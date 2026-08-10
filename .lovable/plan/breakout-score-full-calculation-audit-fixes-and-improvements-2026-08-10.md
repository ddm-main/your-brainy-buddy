# Breakout score — full calculation audit, fixes and improvements

Every claim below was checked against the live database (session 2026-08-10) and the current source this session.

## What the live data says

| Signal | Value (2026-08-10) |
|---|---|
| rows in `market_stock_scores` | 1,917 |
| scored (`breakout_score_v4` not null) | 1,632 — **285 priced but unscored**, 206 of them with context complete |
| `context_complete` | 1,838 |
| sentiment bucket covered | **14 of 1,632** |
| `coverage_share` | **0.91 on every scored row**, `score_ceiling` 100 on every row |
| `strength.breadth` | **exactly 0.50 on all 1,632 rows** — never once a real regime |
| `delivery_pct` | **null on all 1,917 rows** |
| `market_score_distribution` cuts | `strong_cut` / `moderate_cut` / `watch_cut` **NULL** on every session |
| stored bands | STRONG starts at 61, but the UI fallback says 70 |
| `market_score_history` matured 21d rows | 603, **all `context_neutral = true`**; live matured rows: **0** |
| history depth before 2026-07-30 | 21 symbols per session |

## Confirmed bugs

**1. The sentiment bucket is dead, and its 9 points are silently redistributed.**
`market-pipeline-eod`, `market-score-backfill` and `market-screener-asof` never pass `sentiment` at all; aggregates passes it but news/AI coverage is near zero (2 news items in 3 days, 60 AI rows), so only 14 of 1,632 rows score it. Coverage lands at 0.91, and because `scale = min(1/0.91, 1/0.85) = 1.099`, the renormalisation cap never bites — the surviving 91 points are scaled to a full 100 and `score_ceiling` is written as 100. Every published score carries a systematic upward bias from a bucket that has effectively never been measured.
Fix: feed sentiment in all writer paths, or drop `sentiment` from `V4_WEIGHTS` and redistribute its 9 points explicitly. Do not leave a permanently uncovered bucket in the published weight table.

**2. Dropped buckets are written as `0` in `buckets`, indistinguishable from a real zero.**
`buckets[name] = 0` for a null bucket. The explain page and history snapshots therefore show "sentiment 0" as if the stock scored zero on sentiment, when it was never scored.
Fix: write `null` for a dropped bucket and render it as "not scored".

**3. `strength.breadth` is 0.5 for the entire universe.**
`market_breadth_daily` is current to 2026-08-10, yet regime reaches the scorer as null on every row, so the breadth factor is neutral for everyone. A 10%-weight factor that never varies is a constant, and it also props up the strength bucket's coverage so genuinely context-blind rows clear the 0.35 floor.
Fix: wire the daily regime into `ctx.regime` in the aggregates pass, and assert non-null coverage.

**4. `volume.delivery_pct` is a permanently dead sub-factor.**
20% of the volume bucket, null on 100% of rows, no ingest path writes the column. Its weight is quietly renormalised onto rel-volume/OBV/dry-up instead of being reweighted deliberately.
Fix: remove the sub-factor and restate the volume weights, or ingest delivery data.

**5. Band cut-offs are NULL, so three different band systems disagree on one score.**
`refresh_score_distribution` computes `strong_cut`/`moderate_cut`/`watch_cut`, but the row that actually exists is written by the aggregates pass, which fills only `p50/p70/p90` and leaves the cuts NULL. Consequences: `ScoreBadge`/`Analysis` fall back to the absolute 70/55/40, `ScoreExplain`/`ScoreHistoryPanel` use a separate static `bandOf` with no cuts, and the stored `breakout_band` uses its own percentile cuts — which is why a 61 is stored as STRONG and rendered as MODERATE.
Fix: write the cuts in the same upsert (or call the RPC after it), collapse the UI onto one `bandOf(score, cuts)`, and delete the duplicate in `scoreExplain.ts`.

**6. Tracker entry gate is inconsistent with the band it claims to use.**
The tracker enters at the static `SCORE_BAND_STRONG` (70) while STRONG on the same session begins at 61. The UI says "enters at score >= 70".
Fix: pick one definition — calibrated cut or absolute — and use it in both the scorer and the tracker copy.

**7. 285 rows are priced with no score, 206 of them with context complete.**
Those rows have an empty `breakout_v4_coverage` object, i.e. the scorer was never run for them rather than having refused them. They still carry a `trade_date` of 2026-08-10 and appear in the universe.
Fix: make the aggregates pass report unscored-but-priced counts, and mark those rows so screeners can exclude them explicitly.

**8. Pattern bucket saturates two points early.**
`pat.bonus` is clamped to 0..10 after the MTF kicker, then normalised against `V4_PATTERN_BONUS_FULL = 6`. Anything from 6 upward is identical, so the MTF agreement bonus is unpaid whenever the base pattern bonus already reaches 6.
Fix: normalise against the true post-MTF ceiling, or cap the MTF kicker inside the 6-point budget.

**9. Penalties are on a 100-point scale but applied to a coverage-reduced ceiling.**
A row at 46% coverage has a ceiling near 54, yet still eats the flat -25 illiquidity or -14 failed-breakout deduction. Thin rows are punished disproportionately relative to how their upside was scaled.
Fix: scale point penalties by the same ceiling, or state the asymmetry in the model docs and the explain page.

**10. Illiquidity is charged three times.**
`turnoverOk === false` forces the volume rel-volume factor to a hard 0, `evaluateLiquidity` gates the row, and a flat -25 penalty is deducted.
Fix: keep the flat penalty, drop the duplicated in-bucket zero.

**11. Calibration and the optimizer run on a replayed 21-symbol sample.**
Of 603 matured 21-day rows, every single one is `context_neutral = true`; there are zero matured live rows, and history before 2026-07-30 holds 21 symbols per session. Any weight or cut derived from this is noise, and `refresh_score_distribution` additionally excludes the 1,460 rows where `is_liquid_tradable` is NULL.
Fix: refuse to fit below a minimum symbol *and* session count, show the sample size on the Calibration page, and backfill history depth before trusting any output.

**12. The aggregates pass hides its own failures.**
Ranking, calibration and score-history phases are each wrapped in a bare catch that never fails the run, and `detection_runs.ok` reflects only tracker errors. A run where the band write threw still reports success.
Fix: record each phase's outcome, write a `failed` row with the error to `market_ingestion_runs`, and surface it on the pipeline health strip.

**13. The EOD pass writes a five-input-blind score that can survive as final.**
It omits `sentiment`, `fundamentals`, `patternsWeekly`, `tierRelVolumePct` and `tierAtrPct`. That is intended as a placeholder, but if aggregates fails or skips a symbol the placeholder is what the app shows, distinguished only by `context_complete`.
Fix: null the score (not just the context columns) on the placeholder write, or badge it as provisional everywhere the score renders.

## Improvements worth making

- **Backfill history depth first.** 21 symbols per session for two and a half months is the binding constraint on every calibration, cut and weight number in the system.
- **Show coverage honestly**: coverage share and real ceiling next to the score on the explain page and in the screener tooltip, plus a "sentiment not scored" line rather than a zero bar.
- **Make `ctx.sectorStrength` unit-checked** — it is the only strength factor passed without a ramp, and a 0-100 value would silently clamp to full credit. It is currently 0..1, so add an assertion before it drifts.
- **Add coverage-invariant tests**: a dropped bucket must never raise the score versus the same input with that bucket scored at its own average; a stale bucket must never change the ceiling silently.
- **Report per-session scoring health** (scored / priced / context-complete / sentiment-covered) so a regression like the 285 unscored rows is visible the day it happens.

## Suggested order

1. Bugs 1, 2, 3, 4 — the model maths itself (weights, dead factors, dropped-bucket display).
2. Bugs 5, 6 — one band definition end to end.
3. Bugs 7, 12, 13 — pipeline honesty and failure visibility.
4. Bugs 8, 9, 10 — calibration details inside the scorer.
5. Bug 11 and the backfill — only meaningful once the above are stable.

## Technical notes

- Files: `supabase/functions/_shared/market/scoring.ts` (buckets, rollup, renormalisation, penalties, `percentileBandCuts`), `supabase/functions/market-pipeline-aggregates/index.ts`, `supabase/functions/market-pipeline-eod/index.ts`, `supabase/functions/market-score-backfill/index.ts`, `supabase/functions/market-screener-asof/index.ts`, `supabase/functions/_shared/market/v4Weights.ts`, `src/lib/market/scoreBands.ts`, `src/lib/market/scoreExplain.ts`, `src/routes/market/ScoreExplain.tsx`, `src/routes/market/Analysis.tsx`, `src/routes/market/Breakout.tsx`, `src/components/market/ScoreBadge.tsx`, `src/components/market/ScoreHistoryPanel.tsx`, `tests/v4-weights.test.ts`, `tests/marketScoring.test.ts`.
- Database: no schema change required. One migration only if the distribution cuts are to be backfilled for past sessions.
- Changing `V4_WEIGHTS` changes every published score, so the weight change (bug 1/4) and a full re-score of the latest session should land together.
