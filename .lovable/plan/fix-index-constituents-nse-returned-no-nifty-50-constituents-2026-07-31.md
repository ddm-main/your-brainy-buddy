# Fix "Index constituents — NSE returned no Nifty 50 constituents"

## What's actually wrong

The red row is a **false alarm about a feed that works**. The probe and the real app use two different sources:

- The app fetches index members from the **niftyindices / NSE archives CSV files** (`market-index-constituents`). Verified in the database: `market_index_members` holds 50 Nifty 50 rows refreshed on 2026-07-30, plus Nifty 100/200/500, Midcap, Smallcap, Bank Nifty and FinNifty. That path is alive.
- The self-test probe calls a **completely different endpoint** — NSE's `api/equity-stockIndices` JSON API, through the cookie-session client. NSE blocks that API from server IPs, so it returns nothing and the probe reports DOWN. The sibling probe on the same client (`candles_1d` via NSE `quote-equity`) fails for the same reason, which confirms it's the endpoint, not the index data.

So nothing about index constituents is broken; the health check is testing a path the app never uses.

## The fix

Point the constituents probe at the real source, so the row reflects reality:

1. Probe the same CSV source the production function uses (`niftyindices.com`, falling back to `archives.nseindia.com`) for the Nifty 50 list, and report the member count.
2. If both CSV mirrors are unreachable at that moment, fall back to reading `market_index_members` freshness: recent rows (within a few days) report **degraded — using stored list**, rather than DOWN. Only report failed when there is neither an upstream answer nor a stored list.
3. Keep the detail line specific, e.g. `50 Nifty 50 constituents (niftyindices)` or `stored list — 50 members, refreshed 1d ago`.

The NSE JSON-API helper stays in the codebase (unused by the probe) — no behaviour change anywhere else.

## Out of scope (say the word and I'll fold them in)

The same NSE API block is why the `candles_1d · NSE` row is red. Daily candles are Yahoo-served in production and are healthy, so that row is the same class of misleading probe. I'd fix it the same way, but only if you want it in this pass.

## Technical notes
- Files touched: `supabase/functions/_shared/market/selftest.ts` (constituents probe only); a small shared CSV-fetch helper moved into `supabase/functions/_shared/market/` so the probe and `market-index-constituents` use one implementation.
- Redeploy: `market-selftest`, `market-index-constituents`.
- No schema changes, no UI changes.
- Verified by re-running the self-test and confirming the Index constituents row reads OK with a member count.
