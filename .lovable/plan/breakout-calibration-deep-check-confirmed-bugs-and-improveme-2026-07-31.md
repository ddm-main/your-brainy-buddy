# Breakout + Calibration — deep check: confirmed bugs and improvements

Verified against the live database and the deployed code this session. Every claim below has a query or a code read behind it.

## What the data actually says

- 9 episodes, and **every new column is still NULL** (`rank_pct`, `mae_pct`, `peak_high`, `trough_low`, `sessions_elapsed`, `trigger_price`, legacy scores). The pipeline has not run since those changes shipped — that is why Rank %ile and MAE show "—" on all 8 visible rows.
- Score history: 2,497 rows for 2026-07-31 and 2,485 for 2026-07-30, but **only 38 rows per day before that**.
- Of 1,567 rows with a matured 21-day return, **only 554 have a benchmark-relative return**, and **every matured row is `context_neutral = true`, covering just 24 symbols**.
- `raw_buckets` is populated on **0 rows**. `market_breakout_snapshots` still holds 9 rows, so the widened (>= 60) capture has not run yet.
- `^NSEI` has 81 bars starting 2026-04-02, while score history starts 2026-02-06.

## Confirmed bugs

**1. Same-day re-runs inflate `below_threshold_days` and cool episodes early.**
The episode tick applies its "already evaluated today" guard to `days_tracked` but not to the below-threshold counter — both branches return the same value, so every re-run adds another day. Live proof: ALKEM and REDINGTON both show `below_threshold_days = 5` after 2 tracked sessions and are already marked **Cooled**, a status they cannot legitimately have reached. Fix: hold the counter flat on a same-day re-run.

**2. Peak return can never be negative, so losers display "Peak +0.00%".**
Peak is seeded at the entry close and only moves up. ALKEM is -0.92% since entry with peak +0.00%, implying it traded back to entry — the data does not support that. Fix: track the true best close since entry and allow a negative peak when the name never traded above entry.

**3. Relative forward returns are permanently stuck NULL on older rows.**
The evaluator only revisits rows where `fwd_ret_21d IS NULL`. Rows evaluated before the `^NSEI` history existed got absolute returns stamped and relative returns left NULL — and will never be reconsidered. That is exactly the 1,567 vs 554 gap. Fix: also re-target rows that have an absolute return but no relative one, after backfilling the index.

**4. The calibration fit is running on 24 symbols of replayed data.**
The fit prefers live full-context rows and falls back to replayed neutral ones. There are **zero** matured full-context rows, so it always falls back — to a 24-symbol, alphabetically-seeded sample scored without regime or sector context. Any weight conclusion from it is noise. Fix: refuse to fit below a minimum symbol *and* session count instead of silently falling back, and say so on the page.

**5. The optimizer draws from the same empty pool.**
It excludes `context_neutral = true`, which removes every matured row, so a run either trips the 100-row floor or fits on almost nothing. The new train/test split exposes this but does not solve it.

**6. Stage and Status are two vocabularies on one row.**
BAJFINANCE reads Stage EXTENDED / Status Active. Stage is derived from *today's* geometry; Status is the episode lifecycle. Nothing on the page says so. Fix: rename the column to "Setup" and cover both in the legend.

**7. Stale trend tail on same-day re-runs.**
On a re-run the score trend array is left untouched, so its last point keeps the earlier intraday score while `last_score` moves. Fix: replace the last element rather than skipping the append.

**8. MAE sorts unknowns to the top.** Missing MAE is coerced to 999, ranking unknown rows above real ones. Fix: sort nulls last in both directions.

**9. Day-1 "Health" of 54-57 on a 0.00% return.** Follow-through on day 1 is almost entirely the not-cooling and score terms, so an untested episode looks half-proven. Fix: show "—" until at least one session has elapsed.

## Improvements that would actually raise score accuracy

- **Backfill depth first.** 38 symbols/day for five months is the binding constraint on every calibration number. Run the score backfill across the universe and extend `^NSEI` back to the first score date; nothing else matters until that lands.
- **Keep the neutral and live populations separate everywhere.** Replayed rows carry no regime or sector context; blending them into one fit is what manufactures confident nonsense.
- **Record the trigger price on the open episodes** — NULL on all 9 today, so day-1 follow-through stays unmeasurable for the current set.
- **Persist `raw_buckets` going forward** (already wired, needs a run) so the optimizer re-weights true post-penalty scores instead of inverting them.
- **De-overlap by symbol, not only by session.** One name appearing on 15 consecutive sessions is one observation, not fifteen, and inflates every correlation.
- **Report coverage on the Lab page** — symbols, sessions, matured rows, benchmark coverage — so a fit on 24 names can never be mistaken for a result.

## Suggested order

1. Lifecycle fixes (1, 2, 7) and the evaluator re-run rule (3) — these are corrupting rows right now.
2. Benchmark and history backfill, then re-evaluate.
3. Fit and optimizer guards plus coverage reporting (4, 5), once a real sample exists.
4. UI corrections (6, 8, 9).

## Technical notes

- Files: `supabase/functions/market-pipeline-aggregates/index.ts` (episode tick), `supabase/functions/_shared/market/scoring.ts`, `supabase/functions/market-score-evaluate/index.ts`, `supabase/functions/market-score-optimize/index.ts`, `src/routes/market/Breakout.tsx`, `src/routes/market/Calibration.tsx`.
- One migration: relax the evaluator RPC so it re-targets rows whose relative return is missing.