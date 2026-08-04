# Make Analysis data current and trustworthy

## Verified diagnosis

- NSE’s authoritative **2026-08-03 bhavcopy succeeded** at 18:45 IST with 3,194 rows in `market_eod_nse`.
- Only **602 Aug 3 rows** reached `market_daily_prices`; 2,592 bhavcopy rows are still missing there. The scoring recovery RPC reads `market_daily_prices`, not `market_eod_nse`, so it could only advance that partial set.
- Only **601 scores** reached Aug 3. MRF has an Aug 3 quote/daily bar, but its newest `market_stock_scores` row is still Jul 31; that is why A3/A5/A6 legitimately display Jul 31.
- `market-pipeline-eod` is failing every 15 minutes: each 100-symbol chunk reports 100 failures because the deployed function writes `breakout_state_days`, but that column is absent in the live DB.
- Three repository migrations containing required scoring columns were never applied: `breakout_state_days`; `ema_cross_20_50_days`, `ema_cross_50_200_days`, `vol_dryup_ratio_base`; and the v4 round-trip fields such as `breakout_state`, fallback levels, touch quality, ATR contraction, and weekly bars.
- The daily-sync summary is correctly marked `partial`, but its freshness check only compares the newest date and counts older score rows. It does not verify expected universe coverage in the canonical EOD staging and normalized price tables.

## 1. Repair the database contract first

- Apply one fresh, idempotent migration that adds **every field currently written/read by the EOD and aggregate scorers**, including all three skipped migration groups.
- Add a canonical, service-role-only database function that promotes a completed NSE bhavcopy session from `market_eod_nse` into `market_daily_prices` with matching OHLCV and trade date.
- Make promotion idempotent with the existing `(symbol, exchange, trade_date)` key and return auditable counts: source rows, promoted rows, skipped invalid rows, and remaining gap.
- Keep existing table grants/RLS unchanged; explicitly revoke public/anon/authenticated execution on the maintenance function and grant it only to `service_role`.

## 2. Fix the post-close pipeline order

- Change `market-daily-sync` to run this strict sequence after the NSE file is available:

```text
NSE bhavcopy → promote full session → cheap full-universe rescore
→ candle enrichment drain → context/sector/breadth aggregates
→ screener snapshot → freshness assertion
```

- Do not treat “latest date exists” as success. Require coverage thresholds against the active NSE universe and the bhavcopy source count.
- Keep per-symbol Yahoo/Kotak candle enrichment as a second-stage enhancement; the authoritative NSE close, return, and volume must not depend on thousands of upstream per-symbol calls succeeding.
- Make the 15-minute catch-up job stop retrying a permanent schema error forever: schema drift remains a hard failure with one deduplicated health incident, while transient symbol/provider failures remain retryable.

## 3. Backfill Aug 3 completely

- Promote all valid Aug 3 NSE bhavcopy rows into `market_daily_prices`.
- Run the batched price rescore across the complete promoted universe.
- Drain `market-pipeline-eod` after the schema fix to populate candle-derived indicators, patterns, support/resistance, weekly context, and v4 inputs.
- Re-run aggregates and rebuild `market_screener_snapshot` only after scoring finishes.
- Verify MRF specifically, then verify market-wide coverage; do not call the run healthy until the price/score/snapshot session and counts reconcile.

## 4. Apply industry-standard freshness semantics to A1–A8

- **A1 Quote / chart:** live Kotak timestamp and source while the market is open; official latest close after market close. Never label a cached last tick as live.
- **A2 AI Verdict:** invalidate or regenerate when its underlying score session changes; show both technical-session time and quote-context time.
- **A3 Breakout, A5 Indicators, A6 Range:** use the newest completed score session only. If today’s official close exists but scoring is incomplete, show `updating after close` or `pipeline delayed`, not a quietly old date.
- **A4 Candles & Patterns:** continue using the selected timeframe’s last bar, but label the bar as forming, settled, or delayed with provider provenance.
- **A7 Fundamentals:** preserve its independent `data_as_of` date; fundamentals are periodic, not intraday, so do not falsely stamp them as today unless the provider actually refreshed them.
- **A8 News / actions:** keep “checked at” separate from article publication/action dates and expose partial sync errors without presenting old articles as a stale feed.
- Centralize freshness classification so Analysis, Screener, Dashboard, and Score Explain cannot disagree about `live`, `settled`, `updating`, `delayed`, or `failed`.

## 5. Make freshness observable and self-checking

- Extend the daily summary metadata with source count, promoted-price count, score count, enriched/context-complete count, snapshot count, and missing-symbol samples.
- Fail the daily run when coverage is materially below the official bhavcopy/active universe, even if all tables contain at least one row for today.
- Surface one compact Analysis warning with a retry/status action when today’s settled close exists but this symbol’s score has not caught up.
- Add targeted tests for bhavcopy promotion, score coverage assertions, missing-column/schema-drift handling, and the five UI freshness states.

## 6. Validate and document

- Confirm the migration exists in live `schema_migrations` and every expected scorer column is visible through PostgREST.
- Confirm `market-pipeline-eod` processes a chunk with nonzero successes and no PGRST204 errors.
- Confirm Aug 3 counts reconcile across staging, daily prices, scores, and snapshot; inspect exceptions rather than hiding them behind a threshold.
- Confirm MRF A3/A5/A6 move to `EOD Aug 03`, A1 remains correctly timestamped, and A7/A8 retain truthful independent dates.
- Run focused market scoring/pipeline tests and responsive browser verification.
- Record every modified/created file in `dependency_manifest.json` and document the data-freshness behavior in `walkthrough.md`, per the project rulebook. Use Supabase only; no Lovable Cloud.

## Expected result

After the post-close NSE file lands, prices become complete first, scoring/enrichment follows, and the UI clearly distinguishes live, settled, updating, and genuinely stale data. A single partial row can no longer make a whole session look healthy.