# Screener vs Economic Times — verified root causes and the fix

## What I verified in the live database (2026-08-05, 10:45 IST)

The live plane itself is healthy: sweeps run every 5 minutes, the 10:40 IST sweep priced 2,591 of 2,595 symbols, and its values match ET almost exactly (ASKAUTOLTD 593.30 / +7.62%, ELANTAS 11,384 / +15.30%, KDDL 3,956.90 / +8.33%, NIACL 183.01 / +6.54%). So the raw data is right — the screener loses it on the way to the screen. Four verified defects:

**1. The snapshot join drops technicals for ~650 symbols (the main bug).**
`market_screener_live` joins scores with `sc.trade_date = en.trade_date` (hard equality). When a symbol's price session is newer than its last scored session, every score-derived field becomes NULL. Measured right now: 655 of 2,830 snapshot rows have no `vol_avg30` — yet 622 of those have a perfectly good `vol_avg30` in `market_stock_scores` on the previous session. `market_stock_scores` itself has only 31 nulls universe-wide.

Consequence: `Volume > 30D Avg Volume` evaluates to **false** for those symbols instead of true/unknown. That is exactly why ET's Cello World, Elantas Beck, Go Digit and La Opala RG never appear in the app — all four are live-priced, above 6%, above ₹100, above ₹1000 Cr, and all four have `vol_avg30 = NULL` in the snapshot. The same NULL wipes `is_liquid_tradable` (690 rows), 52-week distance, RSI, EMA and ATR for those names.

**2. The app was screening a different session than ET.**
The screenshot header reads `EOD 2026-08-04 · same-session values` / `Filters · EOD`. Live mode is a sticky localStorage flag (`screener.liveMode`); once it is off it stays off, so an intraday screen silently compares yesterday's settled closes against ET's live prices. Nothing in the UI says "you are looking at yesterday while the market is open".

**3. Freshness is worse than the stated contract.** Server sweep every 5 min + client `staleTime`/`refetchInterval` of 2 min ⇒ up to ~7 minutes old, with no visible age. ET refreshes continuously.

**4. Symbol identity and universe gaps.** Rashi Peripherals is listed on NSE as **RPTECH** (present and live-priced, but unfindable by the ET name). V-Marc India (`VMARCIND`) is flagged `is_active = false` in `market_stocks`, so it can never appear.

Secondary: market cap is derived by scaling reported cap by `ltp / fundamental_price`, which drifts (ASK Automotive 11,696 vs ET 11,422) whenever the fundamental price base is stale, even though shares outstanding are available for many symbols.

## The fix

### A. Never lose score-derived data because of a date mismatch (database)
Rebuild `market_screener_live` so scores come from a `DISTINCT ON (symbol, exchange) ... ORDER BY trade_date DESC` lateral instead of the equality join, and keep `score_trade_date` on the row so the UI still knows how fresh the indicators are. Slow-moving statistics (`vol_avg30`, `vol_avg20`, 52-week high/low, liquidity, ATR) are valid from the last scored session and must be served; strictly session-bound technicals stay gated by `score_trade_date` as today. `vol_gt_avg30` becomes NULL (unknown) rather than `false` when the average is genuinely missing, so a boolean filter can report "unknown" instead of silently excluding.

Refresh the snapshot after the post-close bhavcopy pass as well as on the current schedule, so its EOD plane is never a day behind the live plane.

### B. Live mode is the default while the market is open
- During 09:15–15:30 IST the screener opens in Live mode regardless of the stored flag; the sticky preference only applies outside the session.
- When the user is in EOD mode intraday, the header shows an explicit warning chip with a one-click "switch to live".
- The mode chip always states the plane and the session: `LIVE · 10:45:12 · 2 min ago` or `EOD 2026-08-04 · settled`.

### C. Real-time parity on price / 1D return / volume
- Client refetch drops to 60 s during market hours and re-pulls as soon as a newer sweep is published, so worst-case age is ~5–6 min instead of ~7, and the age is printed.
- Rows older than two sweep intervals render their price cells as stale (dimmed + age) instead of looking current.
- 1D return continues to be served as `(ltp − settled prev close) / prev close`, verified against the sweep's own `change_pct`.

### D. Volume filter that means what ET means
`Volume > 30D Avg Volume` gets an explicit basis toggle: **Pace-adjusted** (intraday volume vs pro-rated 30-day average — the statistically correct intraday test, current behaviour) and **Raw (ET parity)** (cumulative volume vs full-day 30-day average). Default stays pace-adjusted; the chip states which basis is active. `filterMatchesLive` stops returning `false` when `vol_avg30` is absent — such rows are reported as unknown and counted in the exclusion chip.

### E. Market cap on one honest basis
Prefer `shares_outstanding × live LTP` when shares are known, then consensus cap, then reported cap scaled by a *fresh* price base; never scale by a stale `fundamental_price`. `mcap_basis` already exists — surface it in the column tooltip.

### F. Symbol identity and universe completeness
- Alias map so ET/BSE names resolve: Rashi Peripherals → RPTECH, plus the renames already tracked in `symbolAliases`.
- Reconcile `market_stocks` against the NSE master and bhavcopy: reactivate genuinely listed names flagged inactive (VMARCIND) and report the rest.
- Search matches on company name as well as ticker.

### G. Honest exclusion accounting
The results header reports every reason a candidate was removed — `no quote`, `no 30D average`, `illiquid/SME hidden`, `not in NSE universe` — each with a count and a one-click reveal, so a silent NULL can never look like "no such stock".

## Verification
Sign in as your account in a headless browser during market hours, apply the exact ET set (Price > 100, MCap > 1000 Cr, 1D > 6%, Volume > 30D avg) on NSE, and diff row by row against ET's 13 names, with a named cause for every residual difference (BSE-only listing, BSE price basis, rename, or genuine bug). Repeat after the close against the settled session. Add tests: a symbol whose score session lags its price session still carries `vol_avg30`; a missing average yields unknown, not false; live 1D% equals the sweep's `change_pct`.

## Technical notes
Migration: `CREATE OR REPLACE VIEW public.market_screener_live` (lateral latest-score join), `market_screener_rows` unchanged except for the unknown-vs-false volume semantics, plus a post-close `refresh_market_screener_snapshot` hook. Frontend: `src/routes/market/Screener.tsx` (mode default, chips, exclusion accounting), `src/lib/market/screenerRun.ts` (refetch cadence, mcap basis), `src/lib/market/screenerCatalog.ts` (volume basis, unknown handling), `src/lib/market/symbolAliases.ts`. No destructive migration and no change to stored history.
