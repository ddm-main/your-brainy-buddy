# PostgREST egress: where it actually goes, and a hard 1 MB-per-fetch ceiling

## What the meter says (2026-08-08 → 2026-08-10, 173 MB PostgREST)

Your browsing is not the main driver. Roughly 85% of PostgREST egress is
server-side — cron jobs and edge functions reading through the same public
REST URL, billed identically. Measured per-route, worst first:

| Route | Total | Requests | Per fetch |
|---|---|---|---|
| `market-pipeline-aggregates` → `market_stock_scores` (76 cols) | 31.4 MB | 26 | **1.21 MB** (over ceiling) |
| `market_stocks` (untagged caller) | 19.6 MB | 14,466 | 1.4 KB |
| client `market_screener_rows` (26c + 21c + 22c + 27c) | 26.3 MB | 185 | 113–219 KB |
| `market-live-sweep` → `market_stocks` (1c/4c/5c) | 27.5 MB | 1,883 | 9–22 KB |
| `market_stock_scores` (untagged) | 8.6 MB | 8,127 | 1 KB |
| one-off `market_stock_scores !OVER` | 3.6 MB | 1 | **3.56 MB** |
| `market-pipeline-aggregates` → `market_fundamentals_global` | 1.76 MB | 10 | 176 KB |

Two separate problems: a handful of **oversize responses** (>1 MB), and a lot
of **repeat small reads** (thousands of per-symbol round trips, plus a browser
tab that refetches the screener every 5 minutes for as long as it stays open —
that is why 3–4 opens produced 185 screener fetches).

## The fix

### 1. Hard ceiling enforced in code, not just logged
Today `serverEgress.ts` labels anything over 1 MB `!1MB` and moves on. Add a
shared paging helper that every server read must use, with a page size derived
from the projection width, and make oversize responses a loud failure in dev
plus an auto-halved page size in production. Same on the browser side in
`src/lib/egressMeter.ts`.

### 2. Shrink the pipeline's score read (31 MB → ~6 MB)
- Drop `SCORE_PAGE` from 250 to 100 so a 76-column page lands ~480 KB.
- Trim `SCORE_AGG_COLUMNS`: several JSON blobs (component maps, pattern flags)
  are read but only a few keys are used — those move to scalar columns already
  present on the row, or are dropped from the aggregate pass entirely.
- Page `market_fundamentals_global` at 500 instead of 1000.

### 3. Kill the per-symbol round trips (19.6 MB + 8.6 MB)
`market_stocks` is being read 14,466 times and `market_stock_scores` 8,127
times in three days — one request per symbol somewhere. Trace both untagged
callers (they lack the `srv:<function>` prefix, so the tagging in `cors.ts`
misses them — likely direct `createClient` use outside `preflight`), then
batch them into `.in(symbol, chunk)` reads of 250–500 symbols.
Also tag every remaining caller so no route can stay anonymous again.

### 4. Batch `market-live-sweep`'s universe reads (27 MB)
The sweep re-reads `market_stocks` 1,883 times per cycle across three
projections. Read the universe once per sweep into memory (one paged read of
`market_universe`, symbol + the 5 fields the sweep needs) and reuse it for all
three phases.

### 5. Screener: stop paying full price on every poll
- The 5-minute `refetchInterval` re-downloads the full 113–219 KB board plane.
  Change the poll to a **delta read** — only the live plane (price, change,
  volume, quote state) keyed by the symbols already on screen — and refresh the
  static plane only when the trade date changes.
- Pause polling when the tab is hidden (already done for two queries, missing
  on the main board query at `Screener.tsx:1918`).
- Raise the static-plane session cache TTL so a reload inside the same session
  never refetches it.

### 6. Regression guard
Add a `system_egress_daily` check to the daily maintenance run: any route whose
average bytes-per-request exceeds 1 MB, or whose daily total exceeds a
per-route budget, writes a warning row to `system_maintenance_log` so the next
regression shows up the day it lands rather than at the end of the cycle.

## Expected outcome
No single fetch over 1 MB anywhere (client or server), and cycle PostgREST
egress down from ~58 MB/day to roughly 15–20 MB/day.

## Technical notes
- Files: `supabase/functions/_shared/market/serverEgress.ts`,
  `supabase/functions/_shared/cors.ts`,
  `supabase/functions/market-pipeline-aggregates/index.ts`,
  `supabase/functions/market-live-sweep/index.ts`,
  `src/lib/market/screenerRun.ts`, `src/routes/market/Screener.tsx`,
  `src/lib/egressMeter.ts`.
- No schema changes expected beyond the maintenance-log warning rows.
- Verification: re-read `system_egress_daily` after one pipeline cycle and one
  screener session and confirm no route carries the `!1MB` or `!OVER` suffix.
