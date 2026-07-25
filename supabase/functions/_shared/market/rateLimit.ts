// Per-user in-memory sliding-window limiter for market-* edge functions.
// Each function gets its own isolate-scoped instance — state can't be
// shared across separately-deployed functions, so we scope by call-site.
// This is best-effort (an isolate cold-start resets counters), but it
// closes the loop on the most common abuse cases: a buggy client polling
// order-place, or a compromised token spamming LLM/backtest endpoints.
//
// Follows the same pattern as `_shared/rate-limit.ts` but exposes a
// `guard()` helper that returns a canned 429 Response so each function's
// entrypoint stays a one-liner.
import { corsFor } from "../cors.ts";
import { createSlidingWindowLimiter, type SlidingWindowLimiter } from "../rate-limit.ts";

export interface MarketLimiter {
  guard(req: Request, userId: string): Response | null;
}

export function createMarketLimiter(max: number, windowMs: number): MarketLimiter {
  const inner: SlidingWindowLimiter = createSlidingWindowLimiter(max, windowMs);
  return {
    guard(req: Request, userId: string): Response | null {
      const r = inner.check(userId);
      if (r.ok) return null;
      return new Response(
        JSON.stringify({ error: "rate_limited", retry_after: r.retryAfter }),
        {
          status: 429,
          headers: {
            ...corsFor(req),
            "Content-Type": "application/json",
            "Retry-After": String(r.retryAfter),
          },
        },
      );
    },
  };
}