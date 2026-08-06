# Screener ↔ Economic Times parity — verified causes and the fix

## What I verified in the live database (2026-08-04, 20:10 IST)

The live plane is healthy: 2,564 priced rows, one promoted sweep at 17:43 IST, bhavcopy for 2026-08-04 present, 2,797 of 2,800 NSE EQ rows on today's session. So the data is *there* — the mismatch is in how the screener derives, gates and displays it.

Running your exact ET filter set (Price > 100, MCap > 100 Cr, 1D > 8%, Volume > 30D avg) directly against `market_screener_rows` returns **20 rows**, but the app showed **10**. Four separate defects explain every difference:

**1. Market cap is computed from the wrong base (worst bug).**
The view scales `market_stock_scores.market_cap` by `ltp / close`, while the correct reported value sits unused in the same row:

| Symbol | App MCap | `market_cap_reported` | ET |
|---|---|---|---|
| YASHO | 277 Cr | 4,829 Cr | 5,255 |
| RSDFIN | 189 Cr | 105 Cr | 189 |
| KEI | 52,580 | 48,044 | 52,561 |
| ATHERENERG | 49,983 | 49,423 | 57,192 |

Yasho is off by 17x. The scaling divisor `s.close` is the snapshot's settled close, which can be a stale or forming bar, so the ratio is wrong whenever the snapshot lags the sweep.

**2. "Liquid only" silently deletes real ET matches.**
`is_liquid_tradable = false` on AARTISURF, HMVL (Hindustan Media), UEL (Ujaas Energy), RSDFIN — all four are on ET's list. Combined with SME names (DRONE, TIRUPATI, GOYALSALT, GOLDKART, HIGREEN, ENFUSE) this is exactly the 20 → 10 gap. Nothing in the UI tells you rows were removed.

**3. You compared an NSE screen to a BSE screen.**
Your ET screenshot has **BSE** selected. Morganite, Digilogic, Empyrean, Patdiam, Pee Cee Cosma, GLEN, Purple Wave, Forbes and MadhuveerCom18 have no NSE EQ listing, so they can never appear. Three more are just renames the app already carries under different tickers: Glenmark Life → **ALIVUS**, Ujaas Energy → **UEL**, Hindustan Media → **HMVL**. Prices differ slightly because ET prints the BSE close (Graphite 709.80/+8.01 BSE vs 710.05/+7.92 NSE — which is why Graphite falls under the 8% cut in the app and above it on ET).

**4. The "3 stocks excluded — no 2026-08-04 session" banner is technically true but useless.** It fires on 3 symbols out of 2,800 (99.9% coverage) and speaks in pipeline schedules instead of naming them.

## The fix

### A. One correct market cap (database view)
Replace the `market_cap` expression in `market_screener_rows` with a shares-based computation: derive shares from `market_cap_reported` and the price it was reported against, then multiply by the live LTP. When reported cap is missing, fall back to the score cap and mark provenance as `derived`. Expose `mcap_basis` (`reported_live`, `reported_eod`, `derived`) so the tooltip can state the source. Non-destructive `CREATE OR REPLACE VIEW`; no table or history change.

### B. Liquidity and SME are visible, not silent
- Liquid-only defaults **off** for filtered screens.
- When it is on, the results header shows "N hidden — illiquid/SME" with a one-click reveal.
- Add an explicit SME include/exclude chip instead of folding SME into liquidity.

### C. Exchange honesty and symbol identity
- Results header states the exchange basis: `NSE · live sweep 17:43`.
- Add a rename/alias map (GLS→ALIVUS, UJAASENERGY→UEL, HINDMEDIA→HMVL and the rest surfaced by the reconciliation pass) so search and CSV resolve both names.
- Reconcile `market_stocks` against the NSE master; report ET names with no NSE listing as "BSE-only, not in NSE universe" rather than leaving them silently absent.

### D. Anchor and arithmetic validation
Rewrite the checks in `market-data-validation` (it still queries the removed `market_data` table, which is the `PGRST205` error you keep seeing) to assert, per promoted sweep:
- `change_pct = (ltp − prev_close) / prev_close × 100` within rounding,
- `prev_close` equals the previous settled bhavcopy close,
- market cap drift vs `market_cap_reported` under 1%,
- the symbols the sweep failed to price, named.

### E. Freshness UI that names names
Replace the schedule-lecture banner with a compact chip: `2,797/2,800 priced · 3 no quote` and a hover listing the three symbols. Rows without a quote render "no quote" instead of an old value.

### F. Post-close settlement
After the 18:45 IST bhavcopy pass, refresh `market_screener_snapshot` so `close`, `previous_close` and reported cap settle to bhavcopy values — today's snapshot still carries mid-session bases, which is what makes the scaling in (A) drift.

## Verification
Log in as your account in a headless browser, apply the exact four filters, and diff every row against the database and against ET's list, with a named cause for each residual difference (BSE-only listing, BSE price basis, rename, or genuine bug). Then re-check sorting, CSV export, Live/EOD switching and the mobile width.

## Technical notes
Files touched: one `CREATE OR REPLACE VIEW` migration for `market_screener_rows`; `src/routes/market/Screener.tsx` (liquidity/SME chips, header basis, freshness chip); `src/lib/market/screenerRun.ts` (mcap basis projection, alias map); `src/lib/market/screenerCatalog.ts` (SME scope); `supabase/functions/market-data-validation/index.ts` (rewrite); `supabase/functions/market-pipeline-eod` hook for the post-bhavcopy snapshot refresh.

No destructive migration, no historical-price rewrite, live plane stays ephemeral.
