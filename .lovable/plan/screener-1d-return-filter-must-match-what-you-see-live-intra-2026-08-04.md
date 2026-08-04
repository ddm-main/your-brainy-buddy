# Screener: 1D Return filter must match what you see (live intraday)

## What's actually wrong (verified against the live DB)

Your filter said 5–10%, and the table showed −1.48%, +1.58%, +0.21%. Both numbers are "real" — they just come from different sessions:

- **The filter runs on the settled EOD row**, the table's **1D Return / LTP columns render a live Kotak quote**. `Screener.tsx` deliberately keeps filtering "EOD-first" (comment at the `filtered` memo) while overlaying live quotes for display only on the paginated rows.
- Verified in `market_screener_rows`: ATULAUTO `change_pct 9.29`, DIVISLAB `6.57`, FSL `7.36` — all on session **2026-08-03**, all genuinely inside 5–10%. The screen shows their *today* moves (+0.21%, −3.81%, +0.69%). Nothing is "leaking" past the filter; the filter simply isn't looking at today.
- **The universe is split across sessions.** Right now: 1,445 symbols carry `trade_date 2026-08-04`, 1,360 still on `2026-08-03`, a handful on 07-31/07-30. So "42 of 2817" is misleading — a 1D-Return filter can only ever match the subset synced for the newest session.
- **Today's rows are intraday partials, not EOD.** ASKAUTOLTD: `trade_date 2026-08-04`, `sync_source yahoo`, `last_price_sync_at 04:47 UTC` (10:17 IST, mid-session). A pipeline run during market hours stamps today's partial candle as if it were a settled session, and because `latestTradeDateOf` picks the max date, that partial date becomes the "exact session" gate that silences 1,360 otherwise-valid symbols.

## What I'll build

**1. One value, used for both filtering and display (the core fix)**
Live-capable filters — **Price, 1D Return %, Volume, Volume > 30D Avg** — get evaluated against the same live quote the table renders, in a two-pass engine:
- Pass 1: every structural/fundamental/technical filter runs on the settled row (this narrows 2,817 → candidates cheaply, server-narrowed by universe as today).
- Pass 2: batch-quote the candidate set through `market-quotes` (chunks of 200, existing provider routing = Kotak primary, Yahoo fallback) and apply the live filters against those quotes.
- The same live map feeds the table columns, so display and filter cannot drift apart by construction.

**2. Live / EOD mode toggle**
A visible switch in the results header: **Live (intraday)** — default while NSE is open — and **EOD (settled)** for end-of-day parity screening. The header chip states the mode explicitly ("LIVE · intraday 1D return" vs "EOD 03 Aug · settled"), and each live-capable filter row is tagged `live` so it's obvious which fields respond intraday.

**3. Bounded quoting, honest when truncated**
Quoting is capped (default 1,000 candidates, in-flight chunks throttled to stay inside the function's 300/min limiter). If Pass 1 leaves more candidates than the cap, the header says "live-checked 1,000 of N — add a Market Cap or Price filter to narrow" instead of quietly returning a partial list. With any market-cap/price filter set, real screens land well under the cap.

**4. Fix the mixed/partial-session gating (EOD mode)**
- `latestTradeDateOf` gains a settled-session rule: today's date is not eligible as the reference session while the market is open, so an intraday partial row can't become the exact-session gate.
- The results header reports the split plainly: "1,360 symbols not yet synced for 04 Aug — excluded from price/return filters", replacing today's silent drop.
- The existing exact-session strictness for `ltp / change_pct / volume / vol_gt_avg30` stays in EOD mode (it's what keeps stale rows from faking a match).

**5. Volume correctness in live mode**
Live volume comes from the quote when the provider supplies it; `Volume > 30D Avg` compares live cumulative volume against `vol_avg30`. If the provider returns no volume for a symbol, that symbol is excluded from a volume filter in live mode rather than falling back to yesterday's total (which would repeat exactly the bug being fixed).

## Technical notes

- `src/lib/market/screenerCatalog.ts`: add a `live: true` flag on the four live-capable filter defs; add `LIVE_FILTER_IDS`; add `filterMatchesLive(row, af, liveQuote)`; make `latestTradeDateOf` settled-session aware (new optional arg, existing callers unaffected).
- New `src/lib/market/screenerLive.ts`: candidate batch-quote helper (chunk, cap, dedupe, cache by `exchange:symbol`) built on the existing `useQuotes`/`market-quotes` path and the WS push-tick store, so push ticks win over REST.
- `src/routes/market/Screener.tsx`: split the single `filtered` memo into `eodFiltered` (pass 1) → `liveFiltered` (pass 2); replace the paged-only `liveByKey` with the shared candidate map; add the mode toggle, mode chip, per-filter `live` tag, truncation and unsynced-count notices.
- No DB migration and no edge-function change required — `market-quotes` already batches through the active provider.
- Tests added to `tests/screenerFilters.test.ts`: a 5–10% range keeps a row whose live return is 6% and drops one whose EOD was 9% but live is −1.4%; settled-session selection ignores an intraday `trade_date`; missing live volume excludes rather than falls back.

## Out of scope

Changing how the EOD pipeline stamps intraday runs (it needs its own pass); that's why point 4 defends against it on the read side instead.
