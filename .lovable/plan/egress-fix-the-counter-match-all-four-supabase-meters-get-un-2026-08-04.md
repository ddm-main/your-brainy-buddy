# Egress: fix the counter, match all four Supabase meters, get under 4 GB

## Why the error happens (verified)

The panel calls `syncEgressUsage()`, which requests
`GET https://api.supabase.com/v1/projects/<ref>/daily-stats?attribute=total_auth_egress…`.
I pulled the live Management API OpenAPI spec just now: **that path no longer
exists**. The only project analytics routes published today are
`analytics/endpoints/logs`, `logs.all`, `metrics`, `usage.api-counts`,
`usage.api-requests-count`, `functions.combined-stats`. Supabase deprecated the
project daily-stats pipeline and moved usage to an org-level endpoint that is
**not** in the public API either — the org routes are only
`/v1/organizations`, `/{slug}`, `/entitlements`, `/members`, `/projects`,
`/project-claim/{token}`. So the fallback in the code
(`/v1/organizations/{slug}/usage`) is a 404 as well.

Conclusion: there is no supported API that returns the egress number. The
current design cannot be repaired, only replaced.

Second finding: the log route can't substitute. Querying `edge_logs` returns
only ~10 minutes of history on this plan, and `response.headers.content_length`
is present on just 123 of 402 requests (chunked responses carry no length), so
byte totals from logs would be both truncated and wrong.

## The replacement: measure our own egress

Meter the bytes we send, store them per day, and total them over the billing
cycle. This is under our control, is accurate for the paths that dominate, and
doubles as the attribution we need for the optimisation work.

1. **New table `system_egress_daily`** — `(day, source, route, bytes, requests)`,
   service-role write, admin read. Rolls up nightly; keeps 90 days.
2. **Server side** — in `supabase/functions/_shared/market/common.ts`,
   `jsonResponse()` measures the serialized body length and records it
   (buffered in memory, flushed once per invocation) under
   `source='functions'`, keyed by function name. Every market function already
   returns through this helper, so it is one edit for full coverage.
3. **Client side (PostgREST + storage, the dominant share)** — promote
   `src/lib/egressMeter.ts` from a dev-only console tool to an always-on
   accumulator: it already wraps `fetch` and knows each response's byte size and
   the table/function it came from. Add a batched beacon that posts a per-table
   rollup once every 5 minutes and on `visibilitychange`, one small insert, so
   the meter itself costs nothing measurable.
4. **Realtime** — the tick relay counts the payload bytes it fans out and
   reports them on the same beacon under `source='realtime'`.
5. `syncEgressUsage()` is rewritten to sum `system_egress_daily` over the
   current cycle window instead of calling the Management API, writes
   `egress_bytes` / `egress_breakdown` / `egress_synced_at` exactly as today, and
   keeps calling `apply_egress_governor()`. The `SB_MANAGEMENT_TOKEN` path and
   its dead endpoints are deleted, so the toast disappears.
6. The panel gains a **"cycle start"** control (defaults to the 23rd, matching
   the billing cycle) and a manual "reported by Supabase" field, so the measured
   number can be calibrated against the dashboard once per cycle and the drift
   shown as a percentage.

## Matching all four Supabase meters

The Storage & Quota panel currently shows two of the four numbers on the
billing card, and one of them is off.

| Supabase card | App today | Plan |
|---|---|---|
| Egress 5.96 / 5 GB | not synced | measured counter above, budget 4 GB, limit 5 GB |
| Database size 438 / 500 MB | 403.3 MB | `pg_database_size` under-reports: Supabase bills disk incl. WAL and system catalogs. Add the WAL + system-database allowance to `quota_report()` and label the row "disk (incl. WAL)" so it tracks the billing figure |
| Monthly active users 4 / 50,000 | absent | new row: distinct `auth.users` with `last_sign_in_at` inside the cycle, exposed through `quota_report()` |
| File storage 25 MB / 1 GB | 26.2 MB | already correct (ours counts object metadata; keep, note the rounding) |

All four render as the same bar component with the same colour thresholds, so
the panel becomes a mirror of the billing card.

## Getting under 4 GB / month

At 5.96 GB in the current cycle, roughly 2 GB/month has to go. Once the meter
above is live the ranking is measured rather than guessed, but the structural
work is already identifiable from the code:

- **Realtime tick relay** — a private channel fanning out up to 100 symbols
  continuously through the session, with no coalescing. Cap the subscription to
  symbols actually rendered, coalesce to one update per symbol per second, and
  drop the channel when the tab has been hidden for 60 s.
- **Quote polling** — Dashboard polls quotes every 3 s while NSE is open
  (~7,500 responses per open tab per day). Move to 5 s, and to 15 s when the
  window is not focused rather than only when hidden.
- **Chart/candle reads** — `market-candles` returns full series on every range
  switch; add an `if-modified-since`-style cursor so a refresh fetches only new
  bars.
- **`select("*")` reads** — `useStockScores` (109 columns), plus 25 wildcard
  reads in `src/lib/db.ts` (transactions, statements, holdings). Replace with
  explicit projections matching what each screen renders.
- **`market-archive-prices` hourly drain** — each symbol downloads its archive
  object to merge and then downloads it again to verify. Drop the verify
  re-download and move the drain to nightly now that the backlog is at 2,176 /
  2,800.
- **Duplicate cron work** — the screener snapshot and funds sync each run
  several times a day where one run plus the post-close run is enough.

Each change lands with a before/after reading from the new meter, so the
reduction is demonstrated rather than asserted.

## Order of work

1. Meter + table + rewritten sync (kills the error, gives attribution).
2. Four-meter parity in `quota_report()` and the panel.
3. Realtime + polling cuts, then projections, then cron.

## Technical notes

Files: `supabase/functions/_shared/market/egress.ts` (rewrite),
`supabase/functions/_shared/market/common.ts`, `src/lib/egressMeter.ts`,
`src/lib/market/useRealtimeTicks.ts`, `src/components/config/DatabaseStoragePanel.tsx`,
`src/components/hud/QuotaStatusChip.tsx`, plus one migration for
`system_egress_daily`, the `quota_report()` MAU/disk additions and the cron
changes. `SB_MANAGEMENT_TOKEN` becomes unused and can be deleted afterwards.
