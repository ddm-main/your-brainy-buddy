# Market Config — audit and fix plan

## What I verified

- The navbar chip and Feed Routing count **two different things**. The chip (`summarize()` in `src/lib/market/selftest.ts`) counts rows in `market_surface_probes` — currently 16 distinct *surfaces* (quotes, depth, funds, holdings, positions, candles_1d, candles_index_1d, candles_intraday, index_quotes, fundamentals, company_info, shares, indicators, bhavcopy, constituents, corp_actions), of which 4 are failed (fundamentals, shares, indicators, constituents) and 2 degraded (funds, depth) → "10/16". Feed Routing counts the 21 rows of `ROUTED_FEEDS` and applies different rules (heartbeat first, then probe, then table freshness) → "14 live / 1 delayed / 1 fallback / 1 down / 4 idle". Both are internally consistent and mutually contradictory.
- **Funds is genuinely degraded, not a UI bug.** The stored Kotak `/quick/user/limits` payload (last sync 2026-07-30) contains `Net:"0"`, `MarginUsed:"0"`, `Collateral:"0"` and no `CashAvailable`/`MarginAvailable` key at all — every numeric field is `"0"`. `parseKotakLimits` therefore leaves `available_margin` null, and the probe correctly reports "available margin not reported (used=0)". Cause is unconfirmed between (a) the segment/product combos we post, (b) an account that really is at zero, (c) a field-name family we do not map. This must be diagnosed against the raw payload before any parser change.
- **Holdings is not down.** The live probe answers "1 holdings" (ok). But `market_holdings.updated_at` is 2026-07-30 and `market_positions` / `market_quotes` are empty, so every freshness-based view of the account group is a day stale. Nothing schedules an account sync.
- `depth` is degraded only because the market is closed (17:45 IST) — expected, but the panel and the chip disagree on whether that counts as an outage.
- Session windows disagree: the panel closes at 15:30 IST, the edge self-test at 15:45 IST, and the panel has **no holiday check** (the edge function does), so on an exchange holiday the UI will paint live feeds DOWN all day.
- Reference feeds (`fundamentals`, `shares`, `indicators`, `constituents`) are probed **primary-only**: FMP ratios/shares, Alpha Vantage RSI and NSE constituents all fail, yet those feeds have working fallback chains (fmp → yahoo → nse, alpha → computed). The panel shows DOWN for feeds the app actually serves fine from the fallback.

## Fixes

### 1. One status engine, one number
Extract the per-feed status derivation out of `FeedRoutingPanel` into a shared module (`src/lib/market/feedStatus.ts`) that takes probes + heartbeats + freshness + prefs and returns the per-`ROUTED_FEEDS` status. The navbar chip consumes the same function, so both read `x/21` with identical semantics. Chip tooltip lists the actual affected feed labels and the status breakdown.

### 2. Chain-aware status for reference feeds
When the primary probe failed but another provider in the feed's chain has a healthy probe (or the destination table is fresh), report FALLBACK/DELAYED instead of DOWN, and name the failing primary in the detail line. Probe the chain's second provider for the reference surfaces so this is evidence-based, not assumed.

### 3. Funds / margin
- Log and inspect the full raw limits payload for each segment combo (diagnostic first, no blind parser edits).
- Based on that: extend `parseKotakLimits` with the missing field family and, where Kotak reports no explicit available figure, derive `available = net_cash + collateral − used_margin` and mark it as derived rather than reporting null.
- If every combo genuinely returns zeros, surface that as an explicit "broker reports a zero balance" state instead of "degraded — not reported".
- Show the funds error code and last successful sync time in Market Config.

### 4. Account feeds freshness
- Account surfaces (funds/holdings/positions) probed by the cron run use one designated user's session; label them as such in the UI and keep them out of the app-wide health tally (they are per-user, not a shared feed outage).
- Add the missing scheduled account sync (or, if intentionally on-demand only, mark those rows "on demand" so a 1-day-old table stops reading as stale).

### 5. Session/holiday correctness
Single shared helper for "is the NSE session open", holiday-aware (reads `market_holidays`), used by the panel, the chip and the edge self-test. Removes the 15:30/15:45 split and stops holiday false alarms.

### 6. Probe hygiene
- `market_surface_probes` rows are upserted per (surface, provider) and never deleted; add pruning/staleness so a provider removed from a chain stops voting.
- Retry loop in `FeedRoutingPanel` re-creates its interval on every `rows` change and fires `tick()` immediately each time; move the backoff state out of a ref-in-render and gate it on a stable key so background probes cannot burst.
- `anyRetrying` reads a ref during render (not reactive) — move to state.
- "test everything" toast reads `r.providers`; verify the count is real rather than `0/0`.

### 7. Config section review (beyond feed routing)
- Deduplicate the two "test everything" buttons (Providers panel + Feed Routing) onto one mutation and one busy state.
- Providers panel keeps local `live` state that can disagree with stored probe rows after a reload — render from stored rows only.
- Storage & Quota panel: confirm the warn threshold and surface the largest tables with an actionable prune hint (DB is at 434 MB of a 500 MB limit — a real, imminent problem).
- Surface Kotak/Shoonya session expiry countdown and the open route breakers in one place instead of only inside System Feed.

## Technical notes

Files in scope: `src/lib/market/selftest.ts`, new `src/lib/market/feedStatus.ts`, `src/components/config/providers/FeedRoutingPanel.tsx`, `feedCatalog.ts`, `src/components/hud/FeedStatusChip.tsx`, `src/components/config/ProvidersPanel.tsx`, `supabase/functions/_shared/market/selftest.ts`, `supabase/functions/_shared/market/kotakClient.ts`, `supabase/functions/_shared/market/funds.ts`.

Order of work: (1) shared status engine + chip → removes the contradiction the fastest; (2) chain-aware statuses; (3) session/holiday helper; (4) funds diagnosis then parser fix; (5) probe hygiene and config cleanups.
