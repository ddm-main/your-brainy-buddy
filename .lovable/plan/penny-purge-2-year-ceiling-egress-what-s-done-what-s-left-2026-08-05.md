# Penny purge + 2-year ceiling + egress: what's done, what's left

Verified against the live database and cron just now.

## Already complete — no work needed

- **Penny rule live** as an OR rule inside `market_penny_sweep(_min_cap_cr=1000, _min_price=50)`: cap < ₹1,000 Cr (no cap on record = not judged on cap) OR last settled close < ₹50.
- **1,209 symbols flagged**, tradable universe 1,620.
- **Zero penny rows anywhere**: daily prices, EOD, indicators, scores, score history, live prices, fundamentals, shares outstanding, NSE master, screener snapshot — all 0.
- **19 penny triggers** in place, so no job or manual insert can write penny data back.
- **Weekly re-check** `market-penny-sweep-weekly` (Sat 04:15 UTC) now calls the DB function directly, not the edge function.
- **Gap 1 and 2 from the previous plan are already fixed in the function**: it evaluates every symbol regardless of `is_active` (reinstatement into the universe still limited to active ones), and it uses the latest close within the last 10 sessions rather than the exact max date.
- **Gap 3 is closed**: no `vacuum-oneshot-*` jobs remain in cron.
- **2-year ceiling holding**: oldest bar 2024-08-05, newest 2026-08-05, with `jarvis-monthly-history-ceiling` (02:30), `market-archive-prune-monthly` (02:45) and four `jarvis-monthly-vacuum-*` compactions (03:00–03:30) on the 1st of each month.
- **Database at 158 MB** of the 500 MB cap.

## What's actually remaining

### 1. Re-stamp the symbols the new function has never judged (small)

1,983 symbols have `penny_checked_at` null, 355 of them inactive — the fixed function has not run since it was replaced. Run one manual `market_penny_sweep()` so every symbol carries a judgement and a timestamp. Expect no universe change for the active names; the value is that a reactivated symbol can no longer enter unjudged.

### 2. Sweep observability

The function already writes to `market_ingestion_runs` and `system_maintenance_log`, but nothing notices when a week goes by with no run. Add a check inside `run_daily_maintenance()` that flags `penny_sweep_stale` when the newest `penny_sweep` entry is older than 8 days, so a silent failure shows up in the maintenance log the Config page already reads.

### 3. Egress — this is the real remaining problem

Today's PostgREST egress is **~370 MB, and yesterday's 460 MB** — roughly 12 GB/month against a 5 GB free allowance. One route is essentially all of it:

| Route | Requests today | Bytes |
|---|---|---|
| `market_screener_rows (108c)` | 162 | **141 MB** |
| `market_screener_rows` other widths | 43 | ~20 MB |
| everything else combined | ~450 | < 0.5 MB |

The screener already has a two-plane projection (`planProjection`) that narrows to ~12 columns, but the 108-column full plane is still being served 162 times a day — `planProjection` falls back to the full plane whenever a single on-screen field id is not in its `FIELD_STATIC` map, and both callers that pass no field list get the full plane by design. At ~870 KB per request this one fallback is the entire budget.

Fix, in order of payoff:

- **Make the full-plane fallback loud and rare.** Log which field id triggered the fallback, then add the missing ids to `FIELD_STATIC` / `FIELD_LIVE` so the default preset resolves to a narrow projection. The fallback stays as a correctness guard but should stop firing in normal use.
- **Never fetch the full plane for a list view.** Callers that pass no fields (breakout run, initial load) get the visible preset's fields instead of `null`.
- **Cache the static plane per session.** It changes once a day post-close; today it is refetched alongside the live plane on every poll. Key the cache on `eod_trade_date` and only refetch the live plane on the 5-minute cadence.
- **Push the universe filter to the server for the default view too**, so a filtered run stops paying for 1,620 rows when the user is looking at 50.
- **Record the improvement**: `system_egress_daily` already tracks per-route bytes, so the before/after is directly checkable the next trading day.

Target: `market_screener_rows` under ~15 MB/day, total PostgREST egress under ~1 GB/month.

## Technical notes

- Item 1 is a single data call (`select public.market_penny_sweep();`), no schema change.
- Item 2 is one migration replacing `run_daily_maintenance()` with the added staleness check.
- Item 3 is frontend-only: `src/lib/market/screenerRun.ts` (projection map, fallback logging, static-plane cache, server-side universe filter) plus the callers in `src/routes/market/Screener.tsx` and `src/lib/market/breakoutRun.ts`. No displayed value changes — only the number of columns and rows on the wire.
- Nothing in this plan deletes user-owned data; no holdings, positions, watchlist items or alerts reference a penny symbol.
