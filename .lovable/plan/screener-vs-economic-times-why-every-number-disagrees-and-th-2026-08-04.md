# Screener vs Economic Times — why every number disagrees, and the fix

## Verified against the live database (2026-08-04, 16:27 IST)

**1. The screener's price source is a per-symbol "latest" table, not a per-session table.**
`market_stock_scores` holds one row per symbol stamped with whatever date that symbol was last processed:

| trade_date | rows |
|---|---|
| 2026-08-04 | 1,567 |
| 2026-08-03 | 1,193 |
| 2026-07-31 and older | 155 |

No single date covers the 2,801-symbol universe, so `resolveReferenceSession` (≥90% coverage rule) finds nothing eligible, steps back to 2026-08-03 (43% coverage), and the exact-session gate drops the other 1,577 symbols. That is the banner you saw. The banner text is also wrong — it claims "no 2026-08-03 session stored yet" while 1,193 rows for that date exist and are in fact being used.

**2. Rows dated 2026-08-04 are a mix of mid-session prints and real closes.**
`market_daily_prices` has 1,569 rows for 08-04, created between 10:00 and 15:49 IST. Symbols touched in the morning carry a forming bar; symbols touched after 15:30 carry the true close:

| Stock | ET close (08-04) | App shows | App row vintage |
|---|---|---|---|
| Man Infracons | 111.61 / +11.82% | 104.80 / +4.99% | 10:30 IST forming bar |
| Vedant Fashions (MANYAVAR) | 485.90 / +16.04% | 435.50 / +4.00% | forming bar |
| Paushak (PAUSHAKLTD) | 735.20 / +12.63% | 674.90 / +3.39% | forming bar |
| Ather Energy | 1,450.40 / +13.97% | 1,272.70 / +0.98% | price table has the correct 1,450.40 close, but the **score row is still on 08-03** |
| KEI, Yasho, Ujaas, Avadh Sugar | +9% to +12% | 08-03 close, ~0-1% | never re-processed today |

So even where the correct close was ingested, the screener does not see it because scoring never re-ran for that symbol.

**3. The settlement guard added on 08-04 is not actually stopping unsettled writes.**
`_shared/market/settlement.ts` only gates `market-pipeline-eod` and `market-history-backfill`. `market-candles` still uses the older `nseSessionOpen()` rule (index.ts:479), which permits persisting today's bar the moment the clock passes 15:30 IST — before the bhavcopy exists. Bhavcopy coverage confirms the gap: `market_eod_nse` max trade_date is **2026-08-03** (3,194 rows); nothing for 08-04 yet.

**4. Close ingestion is hours late.** The post-close sync runs at 18:45 IST. Between 15:30 and 18:45 the app has no path to real closes — exactly the window you tested in.

**5. The STALE badge is inverted.** `Screener.tsx:724` flags any row whose `trade_date !== latestTradeDate`, where `latestTradeDate` is the *reference* session (08-03). Every row that actually has newer 08-04 data is therefore labelled STALE, and genuinely old rows (07-28…07-31) look identical to them.

**6. Universe / display gaps.** Glenmark Life (GLS) is absent from `market_stocks` (2,801 active), so it can never match. ET also screens BSE-listed names and prints Volume in thousands ('000) while the app prints raw shares.

## The fix

**A. Make the screener read a real session, not a per-symbol latest row.**
Serve Price / 1D Return / Volume for the screen from a single settled session sourced from the bhavcopy table (`market_eod_nse`, complete at 3,194 rows/day), joined to scores for technical/fundamental columns. One date for every symbol means the exact-session gate has nothing to exclude, and the ET comparison becomes apples-to-apples.

**B. One close ingestion pass over the whole universe, right after the close.**
Add a 15:45 IST full-universe close snapshot (batched broker/Yahoo quotes) writing a provisional session, then reconcile it against the bhavcopy at 18:45 IST and re-run scoring for every symbol whose close changed. No more half-processed days.

**C. Enforce the settlement guard everywhere.**
Route `market-candles` (and any other daily writer) through `isPersistableDate`/`settledBars` so a forming bar can never land in `market_daily_prices`. Provisional post-close rows are written only by the pass in B and flagged as provisional until the bhavcopy confirms them.

**D. Honest freshness UI.**
- STALE badge compares against the newest *settled* session and only marks rows genuinely behind it; rows on the freshest date are never flagged.
- Header chip states the session and its status: `EOD 2026-08-03 · settled` / `08-04 · provisional close` / `08-04 · forming`.
- The exclusion banner reports real numbers (date, coverage, count) and offers a one-click "use last settled session".

**E. Universe and display parity.**
Reconcile `market_stocks` against the NSE master + bhavcopy symbol list and insert missing active EQ names (GLS); add the check to `market-data-validation`. Add a Volume unit toggle ('000 vs shares) so ET rows line up visually.

**F. Verification (logged in as your account).**
Re-run your exact ET screen (Price > 100, Mcap > 1000 Cr, 1D > 8%, Volume > 30D avg) in the app and diff stock-by-stock against ET's 10 names, after the 15:45 pass and again after the 18:45 bhavcopy pass.

**G. Tests.** Reference session resolution on a split-date universe; forming bars rejected by every writer; STALE badge only on genuinely-behind rows; screener 1D% equals bhavcopy close ÷ previous settled close.

## Note on what cannot be fully closed

ET shows the live/close feed the instant the market closes. The app can match it from ~15:45 IST once B lands, but between 15:30 and 15:45 the app will honestly show the previous settled session rather than a half-written one.
