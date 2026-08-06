# Penny stocks: purge everything, block everything, re-check weekly

The rule stays exactly as defined: a stock is penny if market cap < ₹1,000 Cr **or** last settled close < ₹50 (no cap on record = judged on price only).

## Verified current state

- 1,209 symbols are flagged `penny_excluded`; the tradable universe is 1,620 and the screener snapshot (1,628 rows) is already penny-free.
- The weekly sweep (`market-penny-sweep`, Sat 04:15 UTC) and the `in_universe` trigger are live and holding — no leaks.
- But penny **data** is still being stored and is still growing. Rows tied to flagged symbols today:

| Table | Rows |
|---|---|
| market_daily_prices | 102,631 |
| market_eod_nse | 7,128 |
| market_indicators_cache | 3,540 |
| market_score_history | 3,830 |
| market_shares_outstanding | 2,047 |
| market_stock_scores | 1,209 |
| market_fundamentals_global | 1,209 |
| market_live_prices | 1,104 |
| market_nse_master | 1,027 |
| market_intraday_prices | 519 |
| market_news / stock_ai / breakout_* / fundamentals | 42 |

- Only `market-scrips-sync` currently respects `penny_excluded`. Every other writer (daily-sync, bhavcopy, live-sweep, close-snapshot, score-evaluate/backfill, indicators, fundamentals, shares-outstanding, news, AI insight) still writes penny rows.
- No holdings, positions, watchlist items or alerts reference a penny symbol, so nothing user-owned is at risk from the purge.

## The fix

### 1. One hard gate at the database, not in 15 edge functions

Add a `BEFORE INSERT OR UPDATE` trigger, backed by one shared function, on every penny-relevant table. If the row's symbol is flagged, the trigger returns NULL — the write is silently dropped instead of erroring, so batch upserts from any job keep working and simply store nothing for penny names.

Tables gated: `market_daily_prices`, `market_intraday_prices`, `market_live_prices`, `market_live_price_stage`, `market_eod_nse`, `market_quotes`, `market_indicators_cache`, `market_stock_scores`, `market_score_history`, `market_fundamentals`, `market_fundamentals_global`, `market_shares_outstanding`, `market_news`, `market_stock_ai`, `market_breakout_tracker`, `market_breakout_snapshots`, `market_screener_snapshot`, `market_nse_master`.

This means: no future code path, cron, or manual insert can put penny data back. The flag is the single source of truth.

### 2. Never create the stock in the first place

`market_stocks` already has the `in_universe` guard. Extend it so a **new** row that fails the thresholds on insert is stamped `penny_excluded = true, in_universe = false` immediately, using the market cap on the incoming row (price-based flagging is left to the weekly sweep, which is where price lives).

### 3. One-time purge of everything already stored

Delete all rows in the tables above for flagged symbols (~124k rows), in batches, and drop the 1,027 penny entries from `market_nse_master` so search/autocomplete stops surfacing them. `market_stocks` rows themselves are **kept** — the flag row is what keeps them out and lets the sweep reinstate them; deleting them would let the master sync re-create them clean.

Score distribution and screener snapshot get refreshed after the purge so aggregates reflect the smaller universe.

### 4. Weekly re-check unchanged, plus a purge step

`market-penny-sweep` keeps its schedule and its symmetric reinstate logic, and gains one step: after flagging, it deletes newly-penny symbols' derived rows (same table list). So a stock that drops below the line this week has its history cleared, not just hidden. Reinstated stocks are re-backfilled by the normal history/score jobs.

### 5. Trim the work jobs do

Universe-reading jobs (`market-daily-sync`, `market-live-sweep`, `market-score-evaluate`, `market-score-backfill`, `market-history-backfill`, `market-fundamentals-sync`, `market-shares-outstanding-sync`, `market-news-sync`) get `.not("penny_excluded","is",true)` on their symbol selects. The triggers already make this safe; this just stops fetching and processing 1,209 symbols we throw away — real savings on egress and runtime.

## Technical notes

- Trigger function is `SECURITY DEFINER`, `STABLE`, looks up `market_stocks.penny_excluded` by `symbol` (+ `exchange` where the table has it); a partial index on `penny_excluded` keeps the lookup cheap.
- Silent-drop (`RETURN NULL`) rather than raising, so a 500-row batch upsert isn't aborted by one penny symbol.
- Purge runs as data statements in batches to avoid a long lock on `market_daily_prices`.
- Work: one migration (trigger function + triggers + insert guard + index), one batched purge, an edit to `supabase/functions/market-penny-sweep/index.ts` for the purge step, and the universe-filter edits across the eight jobs listed above.
