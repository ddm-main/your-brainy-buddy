# Breakout + Calibration — deep audit and fix plan

Verified against the code and the live database on 2026-07-31 (9 tracker episodes, 7,186 score-history rows over 143 sessions, 1,567 matured, 554 with a benchmark-relative return, calibration fitted on 515 replayed rows).

## Part 1 — Breakout: confirmed bugs

**B1. The tracker runs on a different model than everything else.**
`market-pipeline-aggregates` opens and ticks episodes on the legacy `breakoutScore` (`x.breakout`), while score history, bands, the Calibration Lab, the score badge and the explain page all use v4. Today's rows prove the divergence: BAJFINANCE legacy 78 / v4 71, GAIL legacy 76 / v4 58, JAGSNPHARM legacy 47 / v4 57. Clicking a tracked row's score opens an explanation of a number that had no part in the selection. Snapshots (`market_breakout_snapshots.breakout_score`) and `score_trend` carry the legacy score too.

**B2. `trigger_price` is null on every episode.** The column exists and the pipeline now writes it, but the pass has not re-run, so day-1 return is still measured from the detection-day close and every day-1 row reads exactly 0.00%.

**B3. The Stage column can never show TRIGGERED.** `Breakout.tsx` builds the stage input with `breakoutFreshnessDays: null` and `rollingHigh20: null`, and `deriveBreakoutStage` requires a non-null freshness to return TRIGGERED. It also passes `atrContracting: false` and `baseTightness: null`, so COILED only ever fires on a BB squeeze. Stage is structurally limited to LOADING / COILED / ARMED / EXTENDED.

**B4. The score badge is fed legacy components.** `meta.score_components.breakout` is the v2 component map, rendered next to a v4-banded colour.

**B5. Lifecycle drift.** `days_tracked` only advances on sessions where the symbol has data, so the 15-session horizon is elastic; `score_trend` has no gap markers; `extended` is sticky (a name that extends then fades stays "Extended" until it hits -6%); peak is close-based, so intraday peaks and true drawdown are invisible.

**B6. A failed episode can never reopen** — a symbol is blocked from a new episode while any open episode exists, and terminal episodes never reopen on a fresh qualifying signal.

**B7. Non-NSE is structurally blind.** The scoring pass and the daily-price universe are NSE-only, so a BSE episode would never tick.

## Part 2 — Calibration: confirmed bugs

**C1. The fit is built on 38 symbols.** Every session before 2026-07-30 has exactly ~38 rows — the alphabetical head of the backfill (360ONE, AADHARHFC, ABBOTINDIA, ABDL, ABLBL…), which only started writing at 08:05 today. Live full-universe rows exist for two sessions, none matured. The Lab's "n 515, fitted on replayed neutral" is a fit on the first three letters of the alphabet.

**C2. The benchmark is missing for two thirds of the sample.** `^NSEI` has 81 bars, last 2026-07-30, so 1,013 of 1,567 matured rows have a null `fwd_rel_*`. Every relative metric — the headline slope, band "beat NIFTY", the optimizer's entire objective — silently drops them.

**C3. "Score is anti-predictive" is not yet a finding.** Slope -0.17 / r² 0.085 follows from C1 + C2: a replayed, context-neutral, 38-symbol sample with a partial benchmark. The banner states it as fact.

**C4. The optimizer re-scores pre-penalty and compares against a post-penalty threshold.** `rescore()` reconstructs raw bucket values and re-weights them but ignores penalties, the regime multiplier, the fundamental multiplier and the event cap — all applied by the live score. `cohort_n` / `cohort_hit` at "score ≥ 70" therefore measure a cohort the live model would never produce.

**C5. No train/test split and no window purging.** The hill-climb maximises decile spread on the same rows it selects on, and consecutive sessions of one symbol share overlapping 21-day windows, so effective sample size is far below 515. The reported "best" weights are overfit by construction.

**C6. The cohort views ignore population.** `market_score_cohort` and `market_score_cohort_symbols` filter only on model, date and threshold — mixing replayed-neutral and illiquid rows into the same table the band panel carefully separates.

**C7. Band evidence is unusable** — 10 / 1,570 / 6,570 / 30,430 rows with 0 matured in every band, disclosed only in a footnote.

**C8. Backfill throughput cannot close the gap.** The drain does 25 symbols per 5 minutes and has covered 38 of ~2,556 eligible symbols; a usable history is weeks away at that rate.

## Part 3 — What I will change

**Wave 1 — one model everywhere (accuracy)**
- Switch episode open/tick/snapshot, `score_trend` and `detected_score`/`last_score` to v4, keeping the legacy score as a secondary recorded field.
- Store the v4 rank percentile on the episode so "70" means the same thing on the Breakout page, the badge, the explain page and the Lab.
- Fix the badge to pass v4 components.

**Wave 2 — honest episode mechanics**
- Advance `days_tracked` on trading sessions, not on data availability; mark skipped sessions in `score_trend`.
- Track intraday peak/trough from the daily bar for true MFE/MAE, and surface max adverse excursion.
- Let an `extended` episode de-escalate, and let a terminal episode reopen on a fresh qualifying signal after a cooldown.
- Populate `trigger_price` on the next run and measure day-1 return from the trigger.

**Wave 3 — stage and row truth**
- Feed `deriveBreakoutStage` real inputs (rolling high, breakout freshness, ATR contraction, base tightness) so TRIGGERED and COILED can fire.
- Show MAE, distance to trigger and rank percentile on the row.

**Wave 4 — make calibration measurable**
- Backfill `^NSEI` history to match the score-history span, and make the evaluator refuse to stamp `evaluated_at` when the benchmark is absent instead of silently nulling the relative return.
- Raise backfill throughput and add a coverage readout to the Lab — symbols covered, sessions covered, matured rows, benchmark coverage.
- Gate the "anti-predictive" banner behind a minimum sample (symbols ≥ 300, matured ≥ 1,000, benchmark coverage ≥ 90%); below that the header says "insufficient evidence" and names the failing condition.

**Wave 5 — a defensible optimizer**
- Apply recorded penalties and multipliers when re-scoring so candidates are comparable to live scores.
- Split by date: fit on the older two thirds, report the winner's out-of-sample metrics on the newest third, show both.
- De-overlap the sample (one row per symbol per 21-day window) and report effective N alongside raw N.
- Add population filters to the cohort RPCs to match the band panel's fit/all toggle.

**Wave 6 — accuracy improvements to the score itself**
- Sector- and regime-relative normalisation of the levels and volume buckets, so one hot sector cannot own the top decile.
- Band the UI off the persisted percentile cut-offs (`market_score_distribution`) with the 70/55/40 absolutes as fallback.
- Record raw per-bucket values (not only weighted points) in history, so re-weighting no longer needs inversion.

## Technical notes

Files: `supabase/functions/market-pipeline-aggregates/index.ts` (model switch, lifecycle, snapshots), `supabase/functions/_shared/market/scoring.ts` (episode rules), `supabase/functions/market-score-optimize/index.ts` (penalties, split, de-overlap), `supabase/functions/market-score-evaluate/index.ts` plus `evaluate_score_history_forward` / `fit_score_calibration` / `market_score_cohort*` (benchmark guard, population filters), `src/routes/market/Breakout.tsx`, `src/routes/market/Calibration.tsx`, `src/lib/market/breakoutRun.ts`, `src/lib/market/scoreHistory.ts`. Migrations: extra episode columns (v4 score, legacy score, MAE, rank pct), a raw-bucket column on `market_score_history`, and the cohort RPC signatures.

Waves 1–3 are safe to ship immediately. Wave 4 must land before any conclusion is drawn from the Lab; waves 5–6 only become meaningful once the history is broad enough.