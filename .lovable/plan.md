## Plan: clean, compact, and correct the Market Screener (result-parity update)

### What's different vs Tickertape today
Same 4 filters (Market Cap 1000-100000, Price 100-3000, Volume 1L-1Cr, 1D Return 5-10%):
- Tickertape returns 32 stocks (e.g. Va Tech Wabag, Diamond Power, Amagi, Metropolis, Sky Gold, Tips Music, Thyrocare, SG Mart, Inox Green, Madhya Bharat Agro, V-mart, Timex, Smartworks, Jana SFB, SG Finserve, Vishnu Chem, Muthoot Microfin, Styrenix, D P Abhushan, Panama Petrochem, S P Apparels, ...).
- JARVIS returns 23. Missing names include Diamond Power (price ~244), Metropolis, Sky Gold, Tips Music, Inox Green, Madhya Bharat Agro, Timex, Jana SFB, Vishnu Chem, Muthoot, Styrenix, D P Abhushan, Panama Petrochem, S P Apparels.
- Present in JARVIS but not visible in Tickertape's page-1: BLUESTONE, JSFB, PANAMAPET, VSSL, EPIGRAL, GANDHAR, SGFIN, SMARTWORKS, RUBICON, KALPATARU, AEQUS — some are same names under different tickers.

The delta is not a formula bug — it is one or more of:
1. Universe/mapping: some Tickertape names are missing from `market_stocks` (`is_active`), have a different `symbol`, or lack a fresh score row → excluded from our count.
2. Live-filter deferral: with market open + Price/1D Return active + candidates > cap, we currently fall back to EOD but that path is under-applying and marking 656 as "too many". Some candidates get dropped incorrectly.
3. `444 excluded — no synced data yet`: strict tech filtering removes rows without technical data even when EOD price/change and volume exist, which shrinks the visible set.
4. Chg % source mismatch: Tickertape's "1D Return %" is derived from the same close it displays; ours is EOD `change_pct` from `market_stock_scores.change_pct` which for some symbols has null while `close` and `volume` are present.

### Phase 1 — Result parity fixes (highest priority)

Diagnostic pass (read-only):
- Cross-check each missing Tickertape symbol against `market_stocks` + `market_screener_rows` to see whether it is: (a) not in the active universe, (b) has null `close`/`change_pct`/`volume`, or (c) has a stale `trade_date`.
- Log a coverage report so we know exactly why each row is excluded.

Filter engine fixes:
- Remove the "live filter deferral" shortcut when the candidate set exceeds the live cap. Always apply Price and 1D Return % using EOD `close` and `change_pct` as fallback, even when market is open. Live overlay only affects the display, never the filter set.
- Remove the "444 excluded — no synced data yet" behavior for filters that only need EOD price/change/volume. A row with valid `close`, `change_pct`, and `volume` must be evaluated even if RSI/ADX/EMA are missing.
- Keep strict null-exclusion only for filters that require the missing indicator itself (RSI filter needs RSI, ADX filter needs ADX, etc.).
- Ensure Price uses `coalesce(close, ltp)` consistently — the view exposes `close`; some rows have only `close`.
- Confirm 1D Return uses `change_pct` and, when null but yesterday's close exists in `market_daily_prices`, recompute on read.

Universe/data fixes:
- If a Tickertape name is missing from `market_stocks`, mark it as a data gap to backfill (scrips-sync). Do not fake results.
- If a name is present but its EOD row is missing, requeue the symbol for the EOD pipeline.
- Add a compact "Data gaps" chip in the results footer that shows N symbols excluded solely because of missing raw data, so the parity story is transparent instead of a confusing "444 excluded" warning.

Expected outcome:
- With the same 4 filters, JARVIS should match Tickertape within a small delta (±1–2), and any remaining gap should be traceable to a specific symbol not yet in our universe.

### Phase 2 — Compact the Screener UI
Remove verbose text from the main screener screen:
- `NSE universe` explanatory chip.
- Long `excluded — no synced data yet (not out of range)` sentence.
- Long `X candidates — too many for live filtering (cap 300) …` sentence.
- Long health strip caption `Data Health · applicable rows only` and any inline explainer paragraphs.
- Preset "low data" verbose descriptions in main flow (keep them inside the picker only).

Keep only short operational chips:
- Result count: `23 / 2699`.
- Health chips: `Fund 2695/2699`, `Sector 2280/2699`, `Tech 2672/2699`.
- Price mode: `Live` or `EOD`.
- Data-gaps: `N gaps` (opens a small drilldown).

Manual force-resync stays in the overflow menu, silent on success.

### Phase 3 — Data Health accuracy
- Read health totals from `market_pipeline_status` instead of recomputing from `pe`+`roe`. That view already reports 2,695/2,699 covered and only 4 failed, so the UI should agree.
- Remove the misleading `175 upstream failures` message unless `fundamentals_failed > 0`.

### Phase 4 — Filter catalog hygiene
- Keep `nullMeansZero` only where valid (dividend yield, debt/equity).
- Keep alias map: `close→ltp`, `pe_ttm→pe`, `rsi14→rsi`, `adx14→adx`, `above_ema200→above_ema_200`.
- Confirm sector/industry enum options reflect only sectors present in the active universe.

### Phase 5 — Breakout logic (industry-standard tune)
- Keep it as a ranking signal, not a recommendation.
- Weight distribution (adjusted for clarity, not radical change):
  - Volume: relative + volume spike (combined cap ~20).
  - Trend: above 200 EMA + EMA alignment (combined cap ~20).
  - Momentum: RSI sweet spot + MACD histogram/cross (combined cap ~20).
  - Location: distance from 52w high (cap ~10).
  - Market context: sector strength + regime + rel. strength vs NIFTY (combined cap ~20).
  - Optional delivery % (cap ~5) with graceful null.
- Pre-breakout tightens around: BB squeeze, ATR contraction, higher lows, near-resistance, quiet volume, above 200 EMA — no bonus points if the trend is clearly broken.
- Update `tests/marketScoring.test.ts` so strong setups score > 75 and weak/noisy setups score < 25.

### Phase 6 — Background auto-sync fix
- Invalidate the query key actually used today: `screener-rows-v3` (not `screener-rows-v2`).
- Keep success silent, toast only on repeated failure.

### Phase 7 — Validation
- Re-run the exact 4-filter case from the screenshots.
- Confirm every visible row is inside all 4 ranges.
- Compare count directionally against Tickertape; document remaining diffs by symbol so we know they're universe/data gaps, not logic bugs.
- Run vitest for scoring and any affected filter code.
- Browser sanity check that the compact layout matches the intent (no long paragraphs, no oversized warning blocks).

### Notes / non-goals
- We won't force exact parity with Tickertape — their universe includes some names ours may not (or vice versa). The target is: (a) same-filter counts within a small delta, (b) any diff explained by a named data gap, (c) no more silently-dropped rows because of unrelated missing indicators.
- No new backend tables. Universe coverage fixes reuse existing sync jobs.