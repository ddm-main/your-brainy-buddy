## Problem

The user's active provider is already Kotak Neo (`market_api_settings.active_provider = 'kotak_neo'`, `connection_status = 'connected'`) — so provider **selection** is not the bug. The bug is that most screens display **EOD price/1D%** and never overlay a live quote, so numbers sit frozen at yesterday's close.

Audit result, per screen:

| Screen | Price / 1D% source today | Live? |
|---|---|---|
| Dashboard → Top Breakouts | `market_stock_scores.close` overlaid with `useQuotes` (3s) + Kotak WS push | ✅ (during market hours) |
| **`/market/screener` (main results table)** | `market_stock_scores.close` / `.change_pct` via `market_screener_rows` view — **no overlay** (comment at Screener.tsx:262-264 explicitly says "EOD-first, no live overlay") | ❌ |
| IndexDetail (constituents table) | `market_index_constituents` returns `close`/`change_pct` from `market_stock_scores` — no overlay | ❌ |
| Watchlist panel, Positions, Holdings | Already overlay via `useQuotes` / push ticks | ✅ |
| Any panel off-hours | Overlay disabled by `marketOpen()` gate | ❌ (frozen) |

Root cause of the user's complaint: **the main Screener table and constituent tables display raw EOD `close` / `change_pct` with no live overlay**. Top Breakouts *does* overlay, but if the Kotak WS relay isn't running and it's off-hours, that path also freezes.

## Fix plan

### 1. Screener — live Price / 1D% overlay (keep filter math on EOD)

`src/routes/market/Screener.tsx`

- Compute `visibleKeys` = `EXCHANGE:SYMBOL` of the currently paginated rows only (not all 5000 filtered rows — Kotak batch quote limit).
- `useQuotes(visibleKeys, { intervalMs: 2000 })` + `useLiveTickStore` push overlay, same pattern as Dashboard's Top Breakouts.
- Override the `livePrice` / `liveChangePct` column `accessorFn` to prefer the live overlay over `r.ltp` / `r.change_pct`.
- Debounce the visible-key subscription so scrolling/sorting doesn't spam re-subscribes.
- Call `subscribeSymbolsForTicks(visibleKeys)` so the Kotak WS relay pushes those symbols.
- **Filtering stays on the EOD row** — filter → live-column mismatch is intentional (documented) and required for Tickertape parity. Only the *displayed* Price and 1D% become live.

### 2. Screener freshness chip

Add a small provider chip near the results header (same UX as Dashboard's "push · kotak" / "live · kotak" / "delayed"):
- Reads batch-level `provider` from `useQuotes` response + `useRelayAlive` + `anyPush` to render an honest source label.

### 3. IndexDetail constituents — same overlay

`src/routes/market/IndexDetail.tsx` — apply the same visible-page `useQuotes` overlay to the constituents table's Price / Change columns.

### 4. Off-hours: don't freeze the overlay, just stop polling

`src/lib/market/hooks.ts` — `useQuotes`:
- Keep the poll-during-market-hours behavior, but on the last successful fetch during market hours, keep the value visible rather than reverting to `null` (already the case since react-query cache persists).
- Confirm off-hours a single one-shot fetch runs on mount so the panel shows the freshest available close rather than being blank; add `staleTime: Infinity` when `marketOpen() === false` to avoid unnecessary refires.

### 5. Kotak WS relay coverage for Screener

`src/lib/market/useRealtimeTicks.ts` already exposes `subscribeSymbolsForTicks` (debounced 500ms, capped at 100). Bump the cap only for Screener page? No — 100 is a sane relay limit. Instead, hook Screener's *visible page* (page-size default 50), not the full filtered set.

### 6. Provider guardrail

Add a subtle warning strip on `/market/screener` and Dashboard when `market_api_settings.active_provider !== 'kotak_neo'` OR `connection_status !== 'connected'`, telling the user "Prices via Yahoo (~15m delayed) — connect Kotak Neo in Config for live prices." This makes the "why lagging" case self-explanatory the next time it happens.

### 7. Kotak quote freshness

`supabase/functions/_shared/market/provider.ts` (kotakProvider.getQuotes) — verify it hits Kotak's `/quotes/*` endpoint (or the LTP endpoint) rather than a cached snapshot. If it's using the batched limits endpoint, switch to the LTP endpoint for lower latency. (Read-only investigation first — will inspect in build mode; only patch if we find a stale path.)

### Scope excluded

- No changes to filtering semantics or EOD scoring (that's what the July 22/24 Tickertape-parity fixes locked down).
- No new tables or migrations.
- No changes to Fundamentals/Score/EMA/RSI columns — those are inherently EOD.

## Files touched

- `src/routes/market/Screener.tsx` — visible-page live overlay + provider chip + Yahoo-fallback warning.
- `src/routes/market/IndexDetail.tsx` — same overlay for constituent tables.
- `src/lib/market/hooks.ts` — off-hours `staleTime` refinement on `useQuotes`.
- `src/routes/market/Dashboard.tsx` — same Yahoo-fallback warning (small, shared component).
- (Read-only audit) `supabase/functions/_shared/market/provider.ts` — verify Kotak LTP path; patch only if stale.

## Verification

- Run `curl` against `market-quotes` with a small basket during market hours and confirm `provider: "kotak"` and `as_of = today (IST)`.
- Open `/market/screener` during market hours: Price and 1D% for visible rows update every 2s; chip shows "push · kotak" or "live · kotak".
- Off-hours: shows last close with a "closed" chip, no spinner.
- Disable Kotak (test path): chip shows "delayed · yahoo" and the warning strip appears.