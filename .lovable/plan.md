## Findings (verified)

**1. FII/DII shows `n/a`** — `fii_dii_activity` table is empty. Cron `market-fii-dii-sync` runs Mon–Fri 12:00 UTC and pg_cron says "succeeded" (Jul 22/23/24), but that only means the HTTP POST returned a response — the function itself is almost certainly returning `no rows` / `nse_unreachable_*` / `nse_parse_fail` because `www.nseindia.com` blocks Supabase Edge egress (Cloudflare bot-wall), so the cookie prime + `/api/fiidiiTradeReact` fetch never yields a usable body. No rows have ever landed.

**2. A/D looks off on weekends** — `market_breadth_latest.trade_date = 2026-07-26` (Sun) with `computed_at` from today; breadth job ran on a non-trading day and overwrote Friday's session with a stale/degenerate snapshot. Strip shows this without any as-of context, so the numbers read as "wrong for today".

**3. Price update speed** — REST `useIndices` polls every 1 s and `quoteCache` TTL is 800 ms, which is fine. The real gap is that the Kotak WS relay's index push ticks aren't reaching the strip: `subscribeSymbolsForTicks(["NSE:^NSEI", …])` sends Yahoo-style symbols the relay doesn't recognise as Kotak instrument tokens for indices, so no push ticks overlay and the strip only moves at the REST cadence.

---

## Plan

### A. Fix FII/DII sync (`supabase/functions/market-fii-dii-sync/index.ts`)
1. Try NSE first (kept for when it works), but on any non-2xx / empty-array / parse fail, fall back to **Moneycontrol's public FII/DII endpoint** (`api.moneycontrol.com/mcapi/v1/fno/marketStats/fii-dii-activity` — JSON, no cookies) and, if that also fails, to the **NSE archives CSV** (`archives.nseindia.com/content/fo/fii_stats_<DD-MMM-YYYY>.csv` / cash equivalent) which is served without the bot wall.
2. Normalize all three sources into the same `{ activity_date, segment:'CASH', fii_*, dii_*, net_buy_inr_cr, source }` row and upsert.
3. Add structured logging (`console.info({ source, ok, status, rows })`) so future failures are visible in edge-function logs.
4. Add a one-shot backfill call at deploy time (invoke manually once) to populate the last ~10 sessions.

### B. Make A/D honest on non-trading days
1. `useBreadth()` → change query to `market_breadth_daily` ordered by `trade_date desc` with `advances + declines > 0` filter (skip Sat/Sun degenerate rows), take latest. Drop reliance on `market_breadth_latest` view when it points at a non-trading day.
2. `MarketStrip` A/D chip: append the session date in the tooltip (`title="A/D for <trade_date>"`) and dim the chip when `trade_date !== today IST` so stale sessions are visibly stale, not silently wrong.
3. Same treatment for FII/DII chip tooltip (already partly there — keep the date, dim when >1 trading day old).

### C. Faster live index prices
1. In `Apps/relay/kotak-ws-relay.mjs` (and its symbol→token resolver): map the four index pseudo-symbols (`^NSEI`, `^BSESN`, `^NSEBANK`, `^INDIAVIX`) to their Kotak Neo index instrument tokens (NIFTY 50, NIFTY BANK, SENSEX, INDIA VIX) so `subscribeSymbolsForTicks(["NSE:^NSEI", …])` actually subscribes upstream and pushes ticks.
2. `MarketStrip`: keep the existing tick-overlay path; verify `pushTicks["NSE:^NSEI"]` starts flowing after the relay change (watchdog + `relayAlive` already handle staleness).
3. `useIndices` refetch stays at 1 s during market hours as a REST safety net; drop `quoteCache` `LIVE_TTL_MS` from 800 → 500 ms so the REST poll returns a genuinely new print on every tick even under coalescing.

### D. Verification
- Manually invoke `market-fii-dii-sync` after deploy; confirm row appears in `fii_dii_activity` and strip shows FII/DII values.
- Query `market_breadth_daily` for the latest weekday and confirm A/D chip renders that session's numbers with a dated tooltip.
- Open `/market`, watch the four index chips for sub-second updates during market hours; confirm `PriceSourceChip` shows `push · kotak`.

### Technical notes
- No schema changes required.
- No new secrets required (Moneycontrol + NSE archives are unauthenticated).
- All changes are additive/backward-compatible with existing readers of `fii_dii_activity` and `market_breadth_daily`.
