# Why panels still say 31 Jul — verified findings and the fix

## What I checked in the live database (Aug 03)

| Table | Latest date | Rows for that date | Verdict |
|---|---|---|---|
| `market_eod_nse` (NSE bhavcopy) | 2026-08-03 | 3,194 | complete |
| `market_daily_prices` | 2026-08-03 | 2,812 (universe 2,825) | near complete |
| `market_stock_scores` | 2026-08-03 | 2,808 (178 symbols still older) | mostly current |
| `market_screener_snapshot` | 2026-08-03 | 2,826 | current |
| `market_breadth_daily` / sector strength | 2026-08-03 | — | current |
| **`market_score_history`** | 2026-08-03 | **102 of ~2,545 eligible** | **broken — this is the "31 Jul"** |

DIFFNKG specifically: its `market_stock_scores` row is 2026-08-03 (score 40, RSI 46.3, R 411.97 / S 379.98 — exactly what A3/A5/A6 render). Its newest `market_score_history` row is 2026-07-31.

## Confirmed root causes

1. **Score-history write is truncating.** The aggregates pass builds ~2,545 v4 history rows and upserts them in 500-row chunks, but only 102 landed (alphabetically early symbols only). So the "Last EOD score" block shows the newest row that exists — 31 Jul for most symbols — while the panel's own chip correctly says "EOD Aug 03". Two dates, one card.
2. **The panel never reconciles with the current score.** It reads history only, with no fallback to today's `market_stock_scores` row, and always prints a date even when the data is current.
3. **"no technical snapshot for this symbol" is wrong.** The breakout stage is derived only from the live intraday recompute, which is null when the market is closed. It should fall back to the stored EOD snapshot instead of claiming no data exists.
4. **A1 timestamp is a date rendered as a clock.** `as_of` is a date-only value; parsing it as UTC midnight prints "Aug 03, 05:30 AM" IST — a tick that never happened.
5. **A7 "as of Aug 03" is the sync time, not the fundamentals period.** `data_as_of` is stamped with the fetch timestamp, so quarterly data is labelled as if it were today's.
6. **Coverage gaps are invisible.** 382 bhavcopy rows never reached daily prices, 178 symbols still carry pre-Aug-03 scores, 263 have no v4 score — and the daily run still reports healthy.

## Fix plan

### 1. Backend / data
- Make the history upsert reliable: smaller chunks, retry on failure, and fail the run (instead of silently continuing) when written < eligible. Backfill Aug 03 history for every eligible symbol.
- Re-run promotion + rescore for the 382 missing bhavcopy symbols and the 178 stale scores so every active NSE symbol carries an Aug 03 row.
- Stamp fundamentals with the provider's real reporting period in `data_as_of` and keep the fetch time separate; never present a fetch time as the data date.

### 2. One freshness rule for the whole page
Add a single helper that classifies each panel's data as `live`, `settled`, `updating`, or `stale`, and apply the display rule you asked for:
- **current** (matches the latest settled session, or live during market hours) → no date shown, at most a `LIVE`/`EOD` word.
- **behind the latest settled session** → show the date plus how many sessions behind.
Every panel A1–A8 reads that one helper, so no two cards can disagree.

### 3. Per-panel corrections
- **A1 Quote** — `LIVE hh:mm` while open; after close `Aug 03 close` (date only, no phantom 05:30).
- **A2 AI Verdict** — keep the generated time; flag as outdated only when its underlying score session is behind.
- **A3 Breakout** — prefer today's score row; use history only for the trend strip. No date when it equals the current session. Replace "no technical snapshot" with the stored EOD read when the market is closed.
- **A4 Candles & Patterns** — keep timeframe + last-bar time (a bar always needs its clock), labelled forming/settled.
- **A5 / A6** — no date when current; "updating after close" while the pipeline runs; "N sessions behind" only when genuinely stale.
- **A7 Fundamentals** — show the true reporting period; flag only when the source itself is old.
- **A8 News** — keep "checked at" separate from article dates; surface partial sync errors.

### 4. Source map (also shipped in the UI)
A "Data sources" section listing, per panel, where each value comes from:

| Panel | Data | Source | Table |
|---|---|---|---|
| A1 price / OHLC / depth | live quotes, 5-level depth | **Kotak Neo** (Yahoo fallback when delayed) | `market_quotes` (depth not persisted) |
| A1 prev close, A3/A5/A6 base | daily OHLCV | **NSE bhavcopy** → `market_eod_nse`, promoted | `market_daily_prices` |
| Chart daily / intraday candles | history | **Yahoo** (Kotak publishes no candle API), cache fallback | `market_daily_prices`, `market_intraday_prices` |
| A3 score, A5 indicators, A6 range | computed in-house from daily prices | **JARVIS pipeline** (`market-pipeline-eod` + aggregates) | `market_stock_scores`, `market_score_history` |
| A2 AI verdict | LLM over score + quote context | **AI gateway** | `market_stock_ai` |
| A4 patterns | computed client-side from the chart series | **JARVIS pattern engine** | none (derived) |
| A7 fundamentals | PE/ROE/holdings/growth | **Yahoo / FMP global sync** | `market_fundamentals_global` |
| A8 news, corporate actions | headlines, dividends/splits | **Yahoo news sync**, **NSE/BSE corp actions** | `market_news`, `corporate_actions` |
| Index levels, breadth, sector strength | Nifty & market internals | **Yahoo/NSE** + in-house aggregates | `market_breadth_daily`, `market_sector_strength_daily` |

### 5. Verification
- Confirm Aug 03 counts reconcile across bhavcopy → daily prices → scores → history → snapshot.
- Confirm DIFFNKG shows no stale date anywhere, and A3 stops saying "Jul 31" / "no technical snapshot".
- Add tests for the freshness classifier and the history-write completeness assertion; record files in `dependency_manifest.json` and document the behaviour in `walkthrough.md`.