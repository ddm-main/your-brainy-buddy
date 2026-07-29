## Goal

Panel A3 ("Breakout Intelligence") on `/market/analysis/:symbol` becomes a single-purpose surface: the breakout score, what it is made of, and the evidence that the score works — the score-history feedback loop with forward 5/10/21-day returns. Everything else in that panel moves out or is dropped.

## Verified current state (checked live, 2026-07-29)

- `market_score_history` exists with `score, rank_pct, band, close, buckets, coverage, fwd_ret_5d/10d/21d, evaluated_at` and is **empty (0 rows)** — the v4 aggregates pass hasn't run since it was wired.
- `market_stock_scores.breakout_score_v4` is **null for every row** — same reason.
- `market_scoring_calibration` has 12 rows, but they are legacy `breakout_v2` percentile stats (e.g. `breakout_p50 = 29`), not fitted v4 weights.
- `market_breakout_snapshots` is empty, `market_score_distribution` is empty.
- Nothing in `src/` reads any of these three tables today — the loop has no UI at all.
- A3 currently renders: Breakout Score + stage, Setups chips, Chart Patterns chips, Resistance, Support (`src/routes/market/Analysis.tsx:667-748`).

So the UI work and a data backfill are both needed; without the backfill the new panel would render "no history yet" for weeks.

## What A3 will show

1. **Score row** — score badge with stage chip and the bucket breakdown tooltip (kept, unchanged behaviour), plus band label (STRONG / MODERATE / WATCH / WEAK) and percentile rank within the day's universe.
2. **Coverage / trust line** — which of the 8 buckets actually had data, and a "not scoreable" reason when the readability gate fired (<120 bars), instead of a misleading low number.
3. **Score history sparkline** — this symbol's daily v4 score for the last ~60 sessions from `market_score_history`, with close overlaid so score-vs-price divergence is visible.
4. **Forward returns for this symbol** — for past snapshots that have matured: score on date → realised +5d / +10d / +21d return.
5. **Model calibration (universe-wide)** — hit rate and mean forward return by score band, plus `r2` / `sample_n` from `market_scoring_calibration`, so the panel states plainly how predictive the score has been.

### Removed from A3
- Setups chips, Chart Patterns chips, Resistance, Support rows. Resistance/Support and pattern flags already feed the score's bucket tooltip; the raw chips belong with the chart, so they move into the A4/A5 rails rather than being deleted outright (patterns → A4 Indicators, S/R → A5 Range & Strength). Nothing is silently lost.

## Technical work

**Data layer — new `src/lib/market/scoreHistory.ts`**
- `useScoreHistory(symbol, exchange)` → `market_score_history` filtered by symbol/model `breakout_v4`, ordered by `trade_date`, last 60 rows.
- `useScoreCalibration()` → `market_scoring_calibration` for the current model version.
- `useScoreBandStats()` → aggregated hit-rate / mean forward return per band. Aggregating client-side over thousands of rows is wasteful, so this reads a small `market_score_band_stats` view (new, security-invoker, grouped by `model, band`) exposing `sample_n, hit_rate_5d/10d/21d, avg_ret_5d/10d/21d`.

**Migration**
- Create the `market_score_band_stats` view over `market_score_history` with grants to `authenticated` / `service_role`.
- Add a `market_score_history_symbol_idx (symbol, exchange, model, trade_date DESC)` index — the per-symbol read has no supporting index today.

**Backfill (one-off edge routine, run from Settings → Sync)**
- Replay the v4 scorer over the last ~120 sessions from `market_daily_prices` for the NSE universe, writing one `market_score_history` row per symbol per session with neutral-context flags marked in `coverage` (sector/RS/regime are not reconstructible historically — they must be labelled, not faked).
- Compute `fwd_ret_5d/10d/21d` for every backfilled row that has enough forward bars, then fit the calibration rows for `breakout_v4` and delete the stale `breakout_v2` rows.

**UI**
- New `src/components/market/ScoreHistoryPanel.tsx` holding the sparkline + forward-return table + band calibration block; A3 in `Analysis.tsx` renders the score row, coverage line, and this component.
- Empty/immature states are explicit: "history collecting — N of 21 sessions" rather than blank or zeroed cells.

## Required improvements (the list you asked for)

1. **Run the v4 pipeline** — `breakout_score_v4` is null universe-wide; every v4 surface is dead until the aggregates pass executes on a real session.
2. **Backfill history** — the loop is only meaningful with ≥21 sessions of matured snapshots; cold-start needs the replay above.
3. **Purge legacy calibration rows** — `breakout_v2` percentile rows in `market_scoring_calibration` will be misread as v4 weights.
4. **Label neutral-context snapshots** — backfilled rows lack true sector/RS/regime; mark them in `coverage` and exclude them from calibration fitting so the r² isn't flattered.
5. **Survivorship and liquidity filter in calibration** — fit only on `is_liquid_tradable` symbols, or the hit rate is inflated by illiquid prints.
6. **Forward returns must be adjusted** — use `close_adjusted`; a split inside the 21-day window otherwise reads as a −50% "failure".
7. **Benchmark-relative hit rate** — report forward return *versus NIFTY over the same window* alongside absolute, otherwise a bull month makes every band look predictive.
8. **Per-bucket attribution** — store bucket contributions in `market_score_history.buckets` (already in the schema) and fit per-bucket weights, so calibration says *which* of the 8 sections carries signal rather than only scoring the total.
9. **Retention** — history grows ~2,800 rows/session; add it to `prune_old_data` with a ~400-day window, and index `(trade_date, model)` for the pending-evaluation scan.
10. **Show sample size and confidence** — a band with n<200 must render as "insufficient sample", not as a hit rate.
11. **Distribution table is empty** — `market_score_distribution` needs to populate for the percentile/band cut-offs the panel displays.
12. **Never render a score without coverage** — when the readability gate returns null, A3 shows the reason; today a data-less symbol and a genuinely weak setup both show a low number.

## Notes

Score maths itself is unchanged — this is a presentation and evidence-loop change plus the data backfill required to make it non-empty.
