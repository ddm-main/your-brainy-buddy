# Screener ↔ Economic Times parity: one 5-minute price session for all 2,800 stocks

## What I verified in the live DB (2026-08-04, 16:42 IST)

- `market_stock_scores` is a **per-symbol latest row**, not a per-session table: 1,567 rows on 2026-08-04, 1,193 on 2026-08-03, 155 on 07-31 and older. No single date covers the 2,801-symbol universe, so the client's reference-session resolver falls back to 08-03 and the exact-session gate drops **1,577 symbols** — exactly the banner in your screenshot. That is also why your ET screen (10 names) returned 1 name (EPACKPEB) in the app.
- The 08-04 rows are a **mix of forming bars and real closes** (written between 10:00 and 15:49 IST). Man Infracons shows 104.80 / +4.99% in the app vs 111.61 / +11.82% on ET (10:30 IST bar); Vedant Fashions 435.50 vs 485.90; Paushak 674.90 vs 735.20. Ather Energy has the correct 1,450.40 close in `market_daily_prices` but its score row is still on 08-03, so the screener never sees it. KEI, Yasho, Ujaas, Avadh Sugar were never re-processed today at all.
- `market-close-snapshot` already exists and is cron'd `*/5 10-11 UTC`, but it hard-refuses to run before 15:40 IST and writes into `market_daily_prices`, which the settlement guard (correctly) protects from forming bars. So there is **no intraday path that keeps the whole universe on one timestamp** — the core of your request.
- The STALE badge (`Screener.tsx:737`) compares each row against the resolved reference session, so rows that actually carry the *newest* data get flagged stale while genuinely old rows look fine — inverted.
- Glenmark Life (GLS) is absent from `market_stocks`, so it can never appear. ET prints Volume in thousands ('000); the app prints raw shares.

## The fix

### 1. A live price plane refreshed every 5 minutes, whole universe at once

New table `market_live_prices`: **one row per symbol** (~2,800 rows, upsert-in-place, so DB growth is flat and there is no history bloat) holding `ltp, prev_close, change_abs, change_pct, volume, session_date, provider, as_of`.

New edge function `market-live-sweep`:
- Walks the **entire active universe in keyset batches, self-chaining** until every symbol is written, then stamps a single `sweep_id` + `as_of` so the whole plane shares one timestamp — no half-updated universe, ever.
- Kotak Neo batch quotes first, Yahoo batch fallback for symbols Kotak does not cover; per-symbol `provider` recorded.
- Cron `*/5` across the full session (03:45–10:10 UTC = 09:15–15:40 IST), plus one final sweep right after the close, plus a pre-open sweep that seeds the plane with the previous settled close so the screener is never empty before 09:15.
- `change_pct` is always computed against the **previous settled close** from the bhavcopy/daily table, which is how ET computes 1D — never against an intraday reference.

### 2. Screener reads the live plane for Price / 1D Return / Volume

- `market_screener_rows` gains a join to `market_live_prices`, so `close / change_pct / change_abs / volume` come from the live plane while technicals, fundamentals and scores keep coming from `market_stock_scores`.
- Because every symbol shares one `session_date` + `as_of`, the exact-session gate has nothing to exclude: **the 1,577-stock exclusion banner disappears**, and result counts are out of the full 2,800.
- Filtering and display now read the same value by construction — the two-pass live filter hack in `screenerLive.ts` collapses to a single pass, and the Live/EOD toggle becomes "Live (5-min plane)" vs "EOD (last settled bhavcopy session)" for end-of-day parity work.

### 3. STALE badge removed, replaced with honest freshness

- Drop the per-row STALE chip entirely (with the whole plane on one sweep it is meaningless).
- Header chip states the plane: `LIVE · 16:40 · Kotak 2,614 / Yahoo 187` or `EOD 2026-08-04 · settled (bhavcopy)`. A per-row marker appears **only** in the rare case a symbol's quote failed in the last two sweeps, as a dimmed "no quote" rather than a red alarm.

### 4. Settlement stays honest

- Forming bars still never enter `market_daily_prices` / `market_stock_scores`; the live plane is explicitly ephemeral. Route `market-candles` through `isPersistableDate` so the last unguarded daily writer is closed.
- Post-close: 15:45 IST full-universe close sweep → written as provisional session → reconciled against the 18:45 IST bhavcopy → re-score every symbol whose close changed. That removes the half-processed days that produced the split-date table above.

### 5. Universe and display parity with ET

- Reconcile `market_stocks` against the NSE master + bhavcopy symbol list; insert missing active EQ names (GLS) and add the gap check to `market-data-validation`.
- Volume unit toggle (shares ↔ '000) so rows line up visually against ET, and MCap in ₹Cr confirmed on both sides.

### 6. Verification against your exact ET screen

Logged into the app with your account, I will re-run **Price > 100, MCap > 1000 Cr, 1D > 8%, Volume > 30D Avg** and diff stock-by-stock against ET's 10 names (Ather, KEI, Glenmark Life, Vedant Fashions, Yasho, Man Infracons, Ujaas, Paushak, PNGS Reva, Avadh Sugar), then screenshot the result. Any residual name-level difference gets its own root cause, not a hand-wave.

## Technical notes

- Migration: `market_live_prices` (PK `symbol, exchange`, `sweep_id`, `as_of`, index on `session_date`), GRANTs (`select` to `authenticated`, `all` to `service_role`), RLS read-for-authenticated; rewrite `market_screener_snapshot`/`market_screener_rows` to left-join it.
- New `supabase/functions/market-live-sweep/` (keyset chaining + `EdgeRuntime.waitUntil`, cron secret guard, reuses `_shared/market/provider.ts` batch quote path). Cron via `market_cron_call`.
- Cost/egress: upsert-only, ~2,800 rows × ~78 sweeps/day, no row growth; the screener already reads a projected column set, so egress is unchanged.
- `src/routes/market/Screener.tsx`: remove STALE chip + exclusion banner, single-pass filtering, new header chip, volume unit toggle. `src/lib/market/screenerLive.ts` reduced to the on-screen 1s overlay only. `screenerCatalog.ts`: exact-session gate now trivially satisfied; keep the settled rule for EOD mode.
- Tests: whole-plane sweep leaves no split `session_date`; 1D% equals (ltp − previous settled close)/close; forming bar rejected by every daily writer; ET fixture screen returns the 10 expected symbols.

## Honest limit

Between the 15:30 close and the 15:45 sweep the app shows the 15:30 sweep values, and the authoritative bhavcopy reconciliation still lands at 18:45 IST — intraday numbers before that are broker/Yahoo prints, same as ET's live feed.
