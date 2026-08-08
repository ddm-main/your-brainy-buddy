# Breakout · Score Breakdown · Calibration — audit and rebuild

Verified by signing in as Deepak and opening `/market/breakout` plus the Calibration Lab, and by querying the live database (7,449 score-history rows, 57 sessions, 1,680 symbols; 11 tracker episodes; 140 breakout snapshots; 1 calibration row; 0 optimizer runs).

## What is actually broken

**1. The Calibration Lab is empty even though the evidence exists.**
Live screenshot: "0 QUALIFIERS", "0/0 sessions with none", "no score history in this window yet", "nothing crossed 70 in the last 30 sessions" — while `market_score_history` holds 4,269 liquid rows for the last four sessions and the tracker shows names scoring 70–71 today. The cohort RPC (`market_score_cohort` / `market_score_cohort_symbols`) is returning nothing for the default 30-session / score ≥ 70 window. Exact cause not yet confirmed (candidates: the RPC restricts to matured rows, or to the `full_context` population that only has 7 sessions of data). Step one is to read the function body and pin it down before changing anything.

**2. The model is currently anti-predictive, and the UI hides it.**
On the only population with matured outcomes (`all`):

```text
band       rows   matured21   avg 21d   avg rel 21d   hit 21d
strong      406      74        -0.88       -1.86       45.9%
moderate    905      69        +2.02       +0.50       56.5%
watch      1217     110        +4.49       +2.65       74.5%
weak       4921     350        +3.25       +1.80       67.1%
```

STRONG is the worst band on every measure. The Band Evidence panel defaults to the `fit` population, which has **zero** matured rows (it only starts 2026-07-30), so the user sees four dashes instead of this. The "score is anti-predictive" warning chip is wired to the calibration fit, which never ran — so it never fires.

**3. Calibration has never been fitted, and the reason is invisible.**
The single row in `market_scoring_calibration` is in a legacy shape: `kind='bucket'`, `weight=0`, and the diagnostic text stuffed into `component` ("coverage:insufficient population=replayed_neutral symbols=19 sessions=122"). The UI only reads diagnostics where `kind='diagnostic'`, so this row is silently dropped and the header just says "not fitted yet" with no explanation.

**4. The history that could fit the model is too narrow.**
Matured rows exist only for **21 replayed symbols** (context-neutral backfill, 2026-05-15 → 2026-07-30). Real live-context rows begin 2026-07-30 and none of them mature until late August. `market-score-backfill` exists and is resumable but has only ever covered ~21 names, so the fit is starved by a factor of ~70.

**5. Data-integrity gaps in score history.**
The 1,460 rows dated 2026-07-30 have `is_liquid_tradable = NULL` (not true/false), so they fall out of both populations. 768 rows are flagged illiquid yet still counted in the `all` band stats that the only visible evidence comes from.

**6. Weight search cannot run.**
`market_score_optimize` requires ≥ 20 rows with a non-null relative return per candidate evaluation; the pool of matured rows is 603 across 21 symbols, all context-neutral. Zero optimizer runs have ever been stored. The panel offers a "Run search" button that will return an unexplained empty result.

**7. Breakout table / lifecycle issues.**
- Every episode detected today shows exactly `+0.00%` return, because entry is stamped at the detection-day close. `trigger_price` is now stored on the tracker but is not used or displayed anywhere, so day-1 follow-through is still unmeasurable.
- Health is blank for day-1 rows (correct) but the column still sorts them as `-1`, pushing brand-new top-score names to the bottom of a Health sort.
- MAE and Rank %ile read `n/a` for older episodes, with a tooltip promising they arrive "from the next aggregates pass onward" — three sessions later they are still `n/a` for the pre-existing rows.
- `Rel Vol` values below 1.0 on rows the model calls TRIGGERED contradict the liquidity/expansion story the score claims; the row gives no way to see which bucket carried the score.
- Sparkline titles read "71 → 71 (peak 71)" for single-point episodes — no information.

**8. Score breakdown (ScoreExplain) issues.**
- The header's "Calibration" button navigates to `/market/breakout` instead of opening the Calibration Lab dialog.
- The page shows bucket points and coverage but never the two things that decide whether to trust the number: this symbol's own matured forward returns, and the band's historical hit rate.
- No indication when the displayed score's band is currently unproven or anti-predictive.

**9. Modal layout.**
The Calibration dialog renders as a short card with a large dead area beneath it — the modal does not use the viewport height, and every inner panel has its own scroll region.

## What I will build

### Wave 1 — make the evidence visible (fix first, no model changes)
- Read `market_score_cohort` / `market_score_cohort_symbols` and fix the filter that empties them; add a row-count diagnostic in the panel so an empty cohort states *why* (no rows / none matured / population filter) instead of "no history yet".
- Rewrite the calibration diagnostic reader to also understand the legacy `coverage:...` row, and surface it as a visible chip: population, symbols, sessions, and what is still missing before a fit can run.
- Default Band Evidence to the population that actually has matured rows, with an explicit switch and a per-population "matured rows" count in the header.
- Show the anti-predictive warning from the **band table** (STRONG under-performing WEAK on relative return) as well as from the fitted slope, so it fires today.
- Disable "Run search" with an inline reason when the matured pool is below the engine's minimum, instead of returning a silent empty result.

### Wave 2 — widen the evidence base
- Add a "Backfill history" control in the Lab that invokes `market-score-backfill` in bounded batches and reports coverage progress (symbols with ≥ N snapshots, matured rows, sessions), so the 21-symbol pool grows to a few hundred names.
- Backfill `is_liquid_tradable` for the 2026-07-30 rows so they join a population.
- Exclude illiquid rows from the headline band evidence and label the population plainly.

### Wave 3 — scoring / lifecycle correctness
- Use `trigger_price` for day-1 return when the entry close equals the detection close, and show entry vs trigger in the row so `+0.00%` day-1 rows stop being the norm.
- Backfill `rank_pct` and `mae_pct` for pre-existing episodes rather than leaving permanent `n/a`.
- Fix Health sorting so unrated (day-1) rows sort last in both directions.
- Sparkline: single-point episodes render a dot with a "first session" title, not "71 → 71 (peak 71)".

### Wave 4 — UI for breakdown and calibration
- Calibration modal: full-height layout, one scroll container, sticky section headers, and a top summary strip (matured rows · sessions · symbols · fit state) so the state of the lab is legible in one glance.
- Score breakdown: add a compact "does this band actually work" strip (band hit rate, avg relative 21d, sample size, unproven/anti-predictive flag) and this symbol's own matured snapshots; fix the Calibration button to open the Lab.
- Row-level link from each breakout row into the bucket that contributed most, so a TRIGGERED row with Rel Vol 0.40 is explainable without leaving the table.

## Technical notes

- Frontend: `src/routes/market/Calibration.tsx`, `src/routes/market/Breakout.tsx`, `src/routes/market/ScoreExplain.tsx`, `src/components/market/CalibrationDialog.tsx`, `src/lib/market/scoreLab.ts`, `src/lib/market/scoreHistory.ts`.
- Database: fixes to `market_score_cohort*` and a normalisation of the legacy `market_scoring_calibration` row go through migrations; `is_liquid_tradable` / `rank_pct` / `mae_pct` backfills are data-only migrations.
- Edge functions touched only in wave 2/3: `market-score-backfill` (batch invocation contract) and `market-pipeline-aggregates` (trigger-price return, rank/MAE backfill).
- No change to the live V4 weights in this plan. Re-weighting only becomes defensible once the weight search has a real matured pool — that is the outcome of waves 1–2, not an action inside them.
