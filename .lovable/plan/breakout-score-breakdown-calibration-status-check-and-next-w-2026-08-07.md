# Breakout · Score Breakdown · Calibration — status check and next wave

## Important: the backend is unreachable right now

Every database query this session failed with `Connection terminated due to connection timeout`, and signing in with the supplied credentials hangs on "AUTHENTICATING…" — the Supabase project (`ybtaxgstmxnlwurkritg`) is not answering. So this pass is based on reading the code, not on live data. Any claim about row counts, RPC behaviour, or whether a backfill has run is **unverified** until the project responds; re-verification is step 0 below.

## What the code already contains (previous plan, waves 1–4)

Read directly in the repo:

- `scoreLab.ts` — cohort hooks send `_population` explicitly (the PostgREST overload ambiguity is fixed), `useLabCoverage` counts snapshots / matured 21d / matured-in-fit / live rows / unknown-liquidity, `MIN_OPTIMIZER_ROWS`, and a `useRunBackfill` hook that invokes `market-score-backfill` in bounded batches.
- `Calibration.tsx` — "Evidence available" panel with a Backfill button, legacy `coverage:` diagnostic chip, `not fitted — reason` chip, band-inversion ("STRONG under-performing WEAK") anti-predictive chip that no longer depends on a fitted slope, population switch on Band Evidence, and "Run search" disabled with an inline reason below the minimum pool.
- `ScoreExplain.tsx` — "Track record of this band" panel (matured rows, hit 21d, avg rel 21d, unproven / under-performed flags), Calibration button opens the dialog instead of navigating.
- `Breakout.tsx` — day-1 return measured from `trigger_price`, Entry column shows detection close vs pivot, Health and MAE sort unknowns last, single-point sparkline renders a dot.
- `CalibrationDialog.tsx` — `HudModal … fullHeight`.
- `market-pipeline-aggregates` writes `rank_pct`, `mae_pct` and `trigger_price` on the tracker.

So waves 1, 3 and 4 are largely **built in the frontend**. What was never confirmed to land is everything data-side: whether the cohort RPCs return rows, whether the `is_liquid_tradable` / `rank_pct` / `mae_pct` backfills were actually applied to existing rows, whether a fit or an optimizer run has ever succeeded, and whether the coverage pool has grown past ~21 symbols.

## Plan

### Step 0 — re-verify against the live project (blocking)

Once the database answers: sign in, open `/market/breakout` and the Calibration Lab, and query the evidence tables for snapshot / matured / session / symbol counts, the `market_scoring_calibration` rows, optimizer runs, and the tracker's `rank_pct` / `mae_pct` / `trigger_price` fill rate. Everything below is scoped by what that shows; items already satisfied get struck off rather than rebuilt.

### Step 1 — data backfills (the part the earlier plan never finished)

- `is_liquid_tradable` for the rows where it is NULL, so they join a population instead of falling out of both.
- `rank_pct` and `mae_pct` for pre-existing tracker episodes, replacing the permanent `n/a` and its "from the next aggregates pass onward" tooltip.
- Normalise the legacy `market_scoring_calibration` row (`kind='bucket'`, `weight=0`, diagnostic text in `component`) into a real `kind='diagnostic'` row, then delete the legacy-parsing branch from the UI.
- Run `market-score-backfill` repeatedly until the matured pool covers a few hundred symbols; report coverage progress in the Lab after each batch.

### Step 2 — make the fit and the search actually run

- Re-run the calibration fit on the widened pool and confirm a slope / r² / n row exists; if it still refuses, the refusal reason must be visible in the header chip.
- Run the weight search on the widened pool with a hold-out split; store the run so "previous runs" stops being empty.
- Guard the optimizer against fitting exclusively on replayed context-neutral rows: label it, and require a minimum share of live full-context rows before a candidate can be called a result.

### Step 3 — scoring-logic improvements

- Band evidence drives an explicit model verdict: if STRONG keeps under-performing WEAK on relative return with an adequate sample, the Lab states the model is inverted and proposes the candidate weight vector rather than only warning.
- Exclude illiquid rows from headline band evidence and label the population on every panel that shows numbers.
- Per-bucket predictive attribution (which buckets carry positive slope, which are noise) surfaced as the input to any re-weighting, so a weight change is justified by evidence and not by a single spread number.
- No change to live `V4_WEIGHTS` until step 2 produces an out-of-sample result.

### Step 4 — remaining UI gaps

- Calibration modal: one scroll container with sticky section headers and a single top summary strip (matured rows · sessions · symbols · fit state), replacing the per-panel scroll regions.
- Breakout row: a link from each row into the bucket that contributed most, so a TRIGGERED row with Rel Vol below 1.0 is explainable without leaving the table.
- Score breakdown: show this symbol's own matured forward returns alongside the band track record.

## Technical notes

- Frontend: `src/routes/market/Calibration.tsx`, `src/routes/market/ScoreExplain.tsx`, `src/routes/market/Breakout.tsx`, `src/components/market/CalibrationDialog.tsx`, `src/lib/market/scoreLab.ts`, `src/lib/market/scoreHistory.ts`.
- Database: data-only migrations for the liquidity / rank / MAE backfills and the calibration-row normalisation; RPC changes only if step 0 shows `market_score_cohort*` still returns nothing.
- Edge functions: `market-score-backfill` (batch runs), `market-score-optimize` (population guard), `market-pipeline-aggregates` (rank / MAE for older episodes).
