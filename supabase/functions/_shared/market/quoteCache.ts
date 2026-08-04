// Shared, cross-user quote coalescing for the system market-data feed.
//
// Every signed-in user now reads prices from ONE Kotak Neo session (the
// designated system feed), so N users polling the same symbol at ~1s each
// used to mean N upstream calls on a single broker account — the fastest way
// to get throttled or locked out. This wraps MarketProvider.getQuotes with:
//
//   1. a per-isolate short-TTL cache keyed by "EXCHANGE:SYMBOL", and
//   2. in-flight de-duplication, so concurrent requests for the same symbol
//      await the same upstream promise instead of issuing their own.
//
// TTL is deliberately sub-poll-interval (1.5s live / 15s off-hours) so the
// UI still feels real-time while the upstream call rate stays flat no matter
// how many users or panels are open.
import type { MarketProvider, QuoteRow } from "./provider.ts";

// Sub-poll-interval by design: the UI polls quotes/indices at 1 s, so a
// 1.5 s TTL guaranteed every other poll was served a cached (visibly frozen)
// price. 250 ms keeps upstream coalescing intact (N panels/users on the same
// symbol still cost one broker call) while letting each 1 s poll return a
// genuinely fresh print.
const LIVE_TTL_MS = 250;
const CLOSED_TTL_MS = 15_000;

const cache = new Map<string, { row: QuoteRow; expiresAt: number }>();
const inflight = new Map<string, Promise<Map<string, QuoteRow>>>();

function nseOpenNow(now = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMin >= 225 && utcMin <= 600; // IST 09:15–15:30
}

function ttl(): number {
  return nseOpenNow() ? LIVE_TTL_MS : CLOSED_TTL_MS;
}

// Keep the isolate's cache from growing unbounded on wide screener sweeps.
function prune(): void {
  if (cache.size < 4000) return;
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
}

export function getSharedQuotes(
  provider: MarketProvider,
  keys: string[],
): Promise<QuoteRow[]> {
  const now = Date.now();
  const out: QuoteRow[] = [];
  const missing: string[] = [];
  const waits: Array<Promise<Map<string, QuoteRow>>> = [];
  const waitedKeys: string[] = [];

  for (const key of keys) {
    const cacheKey = `${provider.name}|${key}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > now) { out.push(hit.row); continue; }
    const pending = inflight.get(cacheKey);
    if (pending) { waits.push(pending); waitedKeys.push(key); continue; }
    missing.push(key);
  }

  let fetchPromise: Promise<Map<string, QuoteRow>> | null = null;
  if (missing.length > 0) {
    fetchPromise = provider.getQuotes(missing)
      .then((rows) => {
        const expiresAt = Date.now() + ttl();
        const byKey = new Map<string, QuoteRow>();
        for (const r of rows) {
          byKey.set(r.key, r);
          if (r.price) cache.set(`${provider.name}|${r.key}`, { row: r, expiresAt });
        }
        prune();
        return byKey;
      })
      .finally(() => { for (const k of missing) inflight.delete(`${provider.name}|${k}`); });
    for (const k of missing) inflight.set(`${provider.name}|${k}`, fetchPromise);
  }

  return Promise.all([...(fetchPromise ? [fetchPromise] : []), ...waits]).then((maps) => {
    const wanted = new Set([...missing, ...waitedKeys]);
    const seen = new Set(out.map((r) => r.key));
    for (const m of maps) {
      for (const [k, row] of m) {
        if (wanted.has(k) && !seen.has(k)) { out.push(row); seen.add(k); }
      }
    }
    return out;
  });
}
