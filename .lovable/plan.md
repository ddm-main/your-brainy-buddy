# Penny stocks out for good, universe rescanned monthly

Rule stays as stated: penny = market cap < ₹1,000 Cr **or** last close < ₹50. Unknown cap is judged on price alone; unknown price is judged on cap alone.

## Verified current state

- 2,767 active stocks, 2,708 in universe — but only **235** carry `penny_excluded`. By today's data, **1,099 stocks that fail the rule are unflagged**: 942 fail on cap, 613 on price.
- Cause found in `market_penny_sweep()`: its "clean" branch resets `penny_excluded = false, in_universe = true` for any symbol whose reason is NULL — which includes symbols with no cap on record and no recent close. It also joins prices on `symbol + exchange`, so rows whose exchange doesn't line up look priceless and get reinstated. That is why a previously-correct 1,209-symbol exclusion collapsed to 235.
- The sweep last completed 2026-08-05; the Saturday cron has produced no run since.
- Penny data is still stored, ~137k rows across: `market_daily_prices` 126,512, `market_eod_nse` 3,733, `market_indicators_cache` 3,462, `market_fundamentals_global` 1,416, `market_stock_scores` 1,227, `market_screener_snapshot` 1,086, `market_nse_master` 987, `market_score_history` 623, `market_live_prices` 237, `market_shares_outstanding` 120.
- The `block_penny_rows` write-blocking triggers exist on all 18 derived tables and work — they just do nothing while the flag is wrongly false.
- No holdings, positions, watchlist items or alerts reference any failing symbol, so the purge touches nothing you own.

## The fix

### 1. Make the flag honest again

Rewrite `market_penny_sweep()`:

- Price lookup by **symbol only** (latest non-null close within the last 10 sessions), so exchange mismatches can't hide a ₹12 stock.
- Reinstate only when the stock **positively passes both** tests: cap known and ≥ 1,000 Cr, and close known and ≥ 50. Anything unproven stays excluded instead of being let back in.
- Keep flagging symmetric otherwise: a genuine re-rating or a move above ₹50 brings a stock back on the next scan.

Also extend the `market_stocks` insert guard so a new row with cap < 1,000 Cr is stamped penny at insert (already present) and a row with no cap is left out of the universe until a scan proves it clean.

### 2. Purge everything already stored

One batched purge over all 18 penny-gated tables for every currently-failing symbol (~137k rows), then drop those names from `market_nse_master` so search and autocomplete stop offering them. `market_stocks` rows are kept, flagged — that is what keeps them out and lets a future scan reinstate them.

After the purge, refresh the screener snapshot and score distribution so aggregates reflect the smaller universe.

### 3. Scanning becomes monthly, not weekly

- `market-penny-sweep`: weekly Sat 02:30 UTC → **monthly, 1st of the month 02:30 UTC**.
- `market-scrips-sync` (the NSE listing refresh that adds/removes symbols): weekly Sat 02:00 UTC → **monthly, 1st of the month 02:00 UTC**, so the listing refresh runs immediately before the penny scan and the two settle in one pass.
- Nothing else changes schedule; daily price/score jobs keep running, they simply have 1,400 fewer symbols to touch.

### 4. Stop paying for penny symbols in the daily jobs

Universe-reading jobs (`market-daily-sync`, `market-live-sweep`, `market-score-evaluate`, `market-score-backfill`, `market-history-backfill`, `market-fundamentals-sync`, `market-shares-outstanding-sync`, `market-news-sync`) get an explicit non-penny filter on their symbol selects. The triggers already make this safe; the filter is about not fetching and processing rows we then throw away — direct egress and runtime savings.

### 5. Purge on every scan, not just once

The sweep gains a purge step: symbols newly flagged in a monthly run have their derived rows deleted right there, so a stock that drops below the line has its history cleared rather than merely hidden. Reinstated stocks get re-backfilled by the normal history/score jobs.

## Technical notes

- Work: one migration (rewritten `market_penny_sweep()`, insert-guard tweak, supporting index), one batched data purge, cron reschedule via the data tool (cron entries carry project-specific URLs and keys), an edit to `supabase/functions/market-penny-sweep/index.ts` for symbol-only price lookup plus the purge step, and universe-filter edits across the eight jobs above.
- Purge runs in batches to avoid a long lock on `market_daily_prices`.
- Verification after the run: zero failing symbols left unflagged, zero penny rows in the 18 gated tables, screener snapshot count drops to the clean universe, and the screener/breakout surfaces return no flagged symbol.
