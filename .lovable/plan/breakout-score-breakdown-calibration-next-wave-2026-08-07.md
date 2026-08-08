# Breakout · Score Breakdown · Calibration — next wave

## Status of live testing (read this first)

I could not sign in or query anything this session: the Supabase REST endpoint for `ybtaxgstmxnlwurkritg` answers **HTTP 522** (origin unreachable) and every SQL query times out. The app's login will hang for the same reason, so the credential-based walkthrough you asked for cannot run yet. Everything below that describes current behaviour comes from reading the code in this repo; anything about row counts, whether a fit ever ran, or whether the backfills landed is explicitly marked unverified and is the first step of the work.

Additionally, this project's Supabase is external/unmanaged from the build environment, so automated signed-in browser checks are not available to me — I can verify the UI logic and the data, and you drive the final signed-in pass.

## Bugs found by reading the code (no database needed)

**1. "Run search" unblocks ~5x too early.** The Lab gates the button on `MIN_OPTIMIZER_ROWS = 20` matured rows (`scoreLab.ts`), but `market-score-optimize` refuses unless it has **100+ non-overlapping matured snapshots that also carry `raw_buckets` detail**, and only holds out a test split at 100 train / 50 test. So between 20 and 100 rows the button looks ready, runs, and returns a refusal message — exactly the "silent empty result" the last plan meant to remove.

**2. The gate counts the wrong rows.** `searchBlocked` uses `coverage.matured21`, which counts every matured row including illiquid, context-neutral and detail-less ones. The optimizer's pool is narrower on three axes. The Lab can therefore say "enough evidence" while the optimizer's pool is empty.

**3. The Lab cannot mature or fit anything.** It can invoke `market-score-backfill`, but the pass that actually fills forward returns, runs `fit_score_calibration`, refreshes the distribution and stamps ranks is `market-score-evaluate` — which has no control anywhere in the UI. A fresh backfill produces snapshots that stay unmatured and unfitted until the nightly cron happens to run, so "not fitted yet" is unresolvable from the lab.

**4. Optimizer population provenance is not shown where it matters.** The run row stores `population`, `live_rows`, `neutral_rows`, `split_ok`, `test_n`, and the function silently falls back to the replayed context-neutral pool when live rows < 100. The summary strip's "fitted on …" chip reads the *calibration* coverage meta instead, so a result fitted entirely on replayed neutral rows is presented next to a live-context fit with no distinction.

**5. Live weights are duplicated by hand.** `V4_WEIGHTS` exists in `src/lib/market/scoreLab.ts` and again in `supabase/functions/_shared/market/scoring.ts`. Nothing keeps them in sync, so every "vs live" delta in the weight bars silently drifts the moment the scorer changes.

**6. There is no way to act on a search result.** The Lab ranks candidate weight vectors and then stops — no promote path, no record of which vector is live, no way to compare the current live vector against the last accepted one.

## Plan

### Step 0 — verification pass, once the backend answers (blocking)

Sign in, walk `/market/breakout`, the Score Breakdown page and the Calibration Lab, and query the evidence layer: snapshot / matured / session / symbol counts, `is_liquid_tradable` nulls, `raw_buckets` fill rate, `market_scoring_calibration` rows (fit + diagnostic + per-bucket), optimizer runs, and the tracker's `rank_pct` / `mae_pct` / `trigger_price` fill rate. Each item below is then either struck off as already satisfied or scoped by what the data shows. No model change happens before this.

### Step 1 — make the lab operable end to end

- Gate "Run search" on the optimizer's real requirement (non-overlapping, matured, with bucket detail, in the selected population), not on a loose global count, and show the shortfall as a number: "142 of 100 needed" or "61 short".
- Add an "Evaluate & fit" control that invokes `market-score-evaluate`, reports the rows it matured, whether the fit produced a slope, and the refusal reason if not.
- Chain progress reporting for backfill: after each bounded batch, refresh coverage so the operator can see the pool grow instead of guessing.
- Show run provenance on every optimizer result and in the previous-runs list: population, live vs neutral row counts, split state, test n.

### Step 2 — finish the data-side work the last plan never confirmed

- Backfill `is_liquid_tradable` where NULL so those rows join a population.
- Backfill `rank_pct` and `mae_pct` for pre-existing tracker episodes.
- Normalise the legacy `market_scoring_calibration` coverage row into a `kind='diagnostic'` row, then delete the legacy-parsing branch from `Calibration.tsx`.
- Run backfill + evaluate repeatedly until the matured, liquid, full-context pool clears the optimizer's minimum, and record where it plateaus.

### Step 3 — scoring logic and score quality

- Per-bucket predictive attribution surfaced as the input to any re-weighting: which buckets carry positive slope on matured rows, which are noise, and at what sample size. A weight change must be justified by this table, not by a single spread number.
- Model verdict, stated plainly: with an adequate sample, if STRONG keeps under-performing WEAK on relative return, the Lab says the model is inverted and proposes the candidate vector rather than only warning.
- Population hygiene: illiquid rows excluded from headline band evidence, and every panel that prints a number labels the population it came from.
- Guard the optimizer against declaring a winner off a purely replayed neutral pool — require a minimum share of live full-context rows before a candidate is called a result, and label it otherwise.
- Single source of truth for `V4_WEIGHTS`: the frontend mirror is generated from, or asserted against, the edge scorer so "vs live" deltas cannot drift.
- No change to live weights until an out-of-sample result exists.

### Step 4 — UI for score breakdown and calibration

- Promote path: an explicit, confirmed action that records a candidate vector as the live one, with the run it came from and the out-of-sample number that justified it — plus the ability to see the currently live vector's provenance.
- Score breakdown: this symbol's own matured forward returns alongside the band track record, and a clear unproven / anti-predictive state when the band has no evidence.
- Breakout row: a link into the bucket that contributed most, so a TRIGGERED row with weak relative volume is explainable without leaving the table.
- Calibration modal: one scroll container, sticky section headers, and the summary strip as the only pinned element.

## Technical notes

- Frontend: `src/lib/market/scoreLab.ts`, `src/lib/market/scoreHistory.ts`, `src/routes/market/Calibration.tsx`, `src/routes/market/ScoreExplain.tsx`, `src/routes/market/Breakout.tsx`, `src/components/market/CalibrationDialog.tsx`.
- Edge functions: `market-score-optimize` (population guard, exposed minimums), `market-score-evaluate` (invoked from the Lab), `market-score-backfill` (batch progress), `market-pipeline-aggregates` (rank / MAE for older episodes).
- Database: data-only migrations for the liquidity / rank / MAE backfills and the calibration-row normalisation; `market_score_cohort*` is only touched if step 0 shows it still returns nothing.
- Order matters: step 0 gates everything, and step 3's re-weighting is gated on step 2 producing a real pool.
