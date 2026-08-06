# AI Verdict (A2): once-a-day generation, detail view, bug fixes

Goal: opening a stock never silently spends an AI call, except the first open of that stock on a given trading day. Everything else reads cache.

## How generation will work

```text
open stock  →  ask server for the cached verdict only
                 ├─ cache from today's session exists  → render it, 0 AI calls
                 └─ no verdict for today
                       ├─ first open of this symbol today → generate once
                       └─ already generated/attempted today → show
                                                              "no verdict · Generate"
```

- Server side, the 6h wall-clock TTL is replaced by a **session-anchored TTL**: a cached verdict is fresh when it was computed after both (a) 00:00 IST today and (b) the trade date of the technicals it reasons off. So it regenerates once per trading day, not every 6 hours (which currently fires again at night, on unchanged data).
- The function gains a `generate` flag. Default is **read-only** — it returns the cache (user row, then the nightly shared row) and, on a miss, `payload: null` with no LLM call. Only `generate: true` (first open of the day, or the Refresh/Generate button) may pay for a call.
- The client marks "attempted today" per symbol in local storage keyed by the IST date, so a failed or empty generation is not retried on every re-open. Query `retry` for this endpoint drops to 0 (today a failure silently costs a second call).
- Query caching: `staleTime` until the end of the IST day, no refetch on mount/focus, so tab-hopping between panels and going back to a symbol costs nothing.
- Refresh button gets a short cooldown (disabled while a verdict younger than 2 minutes exists) and a clear "costs one AI call" title.

## Detail view

A new **Detail** button in the panel header opens a modal with everything the compact panel hides:

- Verdict, confidence, alignment, score adjustment and its reason, holding period.
- Full levels table with risk/reward per target and % distance from live price.
- Full rationale (unclamped), all risks, all plausibility flags.
- Evidence block: which inputs the verdict actually had (live quote + its age, market breadth, news headlines counted, fundamentals as-of, score trade date), the model used, generated timestamp, and whether it is stored in cache.
- Regenerate button, with the same cooldown.

## Bugs found (all fixed in this pass)

1. **Silent paid calls on navigation.** The panel generates on mount whenever the cache is older than 6h, with no user intent — the core issue above.
2. **Retry doubles the cost.** The hook uses `retry: 1`, so a failed generation immediately pays for a second gateway call.
3. **Night-time regeneration.** The 6h TTL expires in the evening on data that cannot change until the next session, so an evening visit re-pays for the same verdict.
4. **Vintage label can lie.** The panel prints `EOD <scoreDate>` using the page's own score row, not the score date the function reasoned off. Fix: the function returns the trade date it used and the panel shows that.
5. **"+ live" claimed for a stale quote.** The freshness guard admits quotes up to 18h old; the panel then labels the verdict "+ live" and suppresses the price-drift warning. Fix: return the quote's age, only claim live inside the session, and keep the drift warning otherwise.
6. **A stale verdict still bends today's score.** `score_adjustment` is applied to the displayed breakout score even when the verdict predates the current session. Fix: ignore the adjustment (and label why) once the verdict is older than the score's trade date.
7. **All failures look the same.** Rate-limit (429) and credit/gateway errors both render "AI unavailable — try refresh", inviting another paid attempt. Fix: distinct messages, and no auto-retry on 429/402.
8. **Rationale expander is not accessible.** Clamped rationale toggles via a bare `div` onClick — no keyboard focus, no role. Becomes a real button.
9. **No empty state.** With read-only fetching there was no "nothing cached yet" state; the panel said "press refresh" only when data was undefined. Replaced with an explicit "no verdict for today · Generate" line.
10. **Refresh spam.** The refresh button is enabled the instant a verdict lands, so repeated clicks each cost a call up to the 20/min limiter.

## Technical notes

- `supabase/functions/market-stock-insight/index.ts`: `generate` flag, session-anchored freshness helper, return `score_date`, `quote_age_minutes`, `model`, keep `persisted`/`cached` flags.
- `src/lib/market/hooks.ts`: `useStockInsight(symbol, exchange, { generate })` with day-scoped stale time and `retry: 0`; per-day attempted-set helper in local storage via `safeStorage`.
- `src/routes/market/Analysis.tsx`: first-open-today decision, Detail button + modal (`AiVerdictDetail`), empty/error states, drift and adjustment gating.

No database migration required.
