# Egress pass 3 — hold the cycle under 4 GB and put a counter in the quota panel

Cycle 23 Jul – 23 Aug is at **5.73 GB of 5 GB** (0.73 GB overage). The daily chart
shows the earlier fixes worked: 30 Jul was 1.2 GB, 01–02 Aug were ~120 MB/day.
But 03 Aug jumped back to **365 MB, of which 345.94 MB (94.7%) is PostgREST** —
so the remaining spend is row bytes over the REST API, not Realtime (0.1%),
Functions (3.5%) or Auth (1.9%).

## What the reads confirmed today

1. **`market-pipeline-aggregates` re-downloads the whole score table on every
   run.** It pages `market_stock_scores` with `select("*")` (2 987 rows ×
   123 columns, 25 MB table) plus a full `market_stocks` pass, then computes
   breadth / sector strength / tracker episodes in TypeScript. Edge-function
   reads go out through the public PostgREST URL, so each run bills ~25–30 MB of
   egress. A day with several pipeline passes is the 345 MB day.
2. **`market-score-backfill` drain runs hourly 03–14 UTC on weekdays** and pulls
   up to ~500 daily bars per candidate symbol, per run — a backlog drain paying
   live-feed egress 12 times a day.
3. **`market-rescore-snapshot-retry` runs `*/20` for six hours** after close
   (in-DB, cheap) while `market-screener-snapshot-refresh` runs `*/30` for nine
   hours — more often than the underlying session data changes.
4. **`market-selftest` runs `*/30` during market hours plus every 6 h.**
5. Client side is mostly already fixed (screener projection + 15 min staleTime,
   `liveInterval` gating, blob-free list reads). Residual full-row reads:
   `market_pipeline_status` (`select("*")`, config page), `market_api_settings`
   in `BrokerConnectPanel`, `market_saved_screeners`, `market_score_history`
   (`select("*")`), and the finance/JARVIS layer in `src/lib/db.ts`
   (transactions, statements, emails, holdings, projects — ~30 `select("*")`).
6. **Egress is not readable from Postgres.** `system_quota_state.egress_bytes`
   and `quota_report()` already carry the field and `DatabaseStoragePanel` reads
   it — nothing has ever written it, which is why the bar is empty.

## The fix

### A. Stop the pipeline from shipping the score table (largest single win)
- Replace the full `market_stock_scores` pull with an **explicit column
  projection** of only the fields the aggregate pass reads (breadth EMA flags,
  RSI, close, 52 w flags, sector, market cap, tracker fields). Expected
  ~25 MB → ~2–3 MB per run.
- Filter server-side to the latest `trade_date` instead of downloading every
  session and discarding stale rows in memory.
- Join `sector` / `is_active` / `market_cap` with a Postgres-side view or an
  `in()`-scoped fetch of only the symbols present, instead of the whole
  `market_stocks` table.
- Move the pure aggregations that need no TypeScript (breadth counts, sector
  strength averages) into SQL where a helper already exists, so the rows never
  leave the database.

### B. Cron cadence, matched to how often the data actually changes
- `market-score-backfill-drain`: hourly → twice a day (nightly window), still
  weekday-only.
- `market-screener-snapshot-refresh`: `*/30` → `*/60` during market hours (the
  post-close job stays).
- `market-rescore-snapshot-retry`: `*/20 14-19` → three fixed attempts, and skip
  when the session is already complete.
- `market-selftest-fast`: `*/30` → hourly during market hours; drop the extra
  6-hourly job.
- `market-history-backfill`: keep the nightly triple, keep the circuit breaker.

### C. Remaining client-side full-row reads
Explicit column lists for: `market_pipeline_status`, `market_api_settings`
(BrokerConnectPanel), `market_saved_screeners`, `market_score_history`, then the
`src/lib/db.ts` list views that read large tables (transactions, statements,
emails, holdings, subscriptions) — list rows render a handful of fields but
currently ship every column, including statement text and parse payloads.

### D. Egress counter in the DB storage & quota panel
Egress can only come from the Supabase Management API, so:
- New scheduled function `supabase-usage-sync` (2×/day) calls the Management API
  usage endpoint with a project access token stored as a secret, and writes
  `egress_bytes`, the cycle window and the per-type split into
  `system_quota_state`.
- `quota_report()` returns the egress figure, cycle dates and the derived
  percentage of a **4 GB self-imposed budget** (not the 5 GB hard cap).
- `DatabaseStoragePanel` gains an Egress row: used / 4 GB budget / 5 GB cap,
  colour-coded at 80% of the budget, with the last-synced timestamp and the
  Auth / PostgREST / Storage / Realtime / Functions split.
- The existing maintenance governor gains an egress band: over 80% of the 4 GB
  budget it sets `low_bandwidth`, which already short-circuits the
  non-essential syncs.

I need a Supabase **personal/project access token** for step D — the Management
API is the only source of the egress number. I will ask for it as a secret when
building; if you would rather not issue one, the panel can instead show a local
estimate (bytes counted per request by a client-side wrapper), which is useful
for spotting regressions but will not match the billing page.

### E. Guard against regression
- Dev-only response-size logger per query key, so a heavy read is visible while
  building.
- A short note in `.lovable/free-plan-2026-07.md` recording the new budget and
  the cadence table.

## Order of work
1. A (pipeline projection) — biggest and server-side only.
2. B (cron cadence) — one migration, zero UI risk.
3. D (egress counter + governor band).
4. C (client projections).
5. E (measurement + notes).

## Technical notes
Files: `supabase/functions/market-pipeline-aggregates/index.ts`,
`supabase/functions/market-score-backfill/index.ts`, a new
`supabase/functions/supabase-usage-sync/`, one migration for the `cron.job`
schedules + `quota_report()` + `system_quota_state` columns,
`src/components/config/DatabaseStoragePanel.tsx`,
`src/routes/config/SystemDataConfig.tsx`,
`src/components/market/BrokerConnectPanel.tsx`, `src/lib/market/hooks.ts`,
`src/lib/market/scoreHistory.ts`, `src/lib/db.ts`.
No behaviour or number changes intended — same data, fewer bytes, fewer calls.
