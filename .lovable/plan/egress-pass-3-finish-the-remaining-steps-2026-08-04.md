# Egress pass 3 — finish the remaining steps

Verified against the code today: steps A, B and the backend half of D are already
shipped. What is left is the panel UI, the client-side projections, and the
measurement notes.

## Already done (confirmed in code)

- **A — pipeline projection.** `market-pipeline-aggregates` now reads an explicit
  column list with a server-side `trade_date` filter, and joins
  `market_stocks` with `symbol,exchange,sector,is_active,market_cap` only.
- **B — cron cadence.** Migration `20260804053238…` retimes
  `market-score-backfill-drain` to `10 19,22 * * 1-5`,
  `market-screener-snapshot-refresh` to hourly, `market-selftest-fast` to hourly
  and unschedules `market-selftest-hourly`.
- **D (backend).** `system_quota_state` carries `egress_bytes`,
  `egress_breakdown`, window dates, 4 GB budget and 5 GB cap; `quota_report()`
  returns them; `apply_egress_governor()` flips `low_bandwidth` past 80% of
  budget; `supabase-usage-sync` exists and is scheduled `5 2,14 * * *`.

## Remaining work

### 1. Management API token (blocks the number showing up)
`supabase-usage-sync` returns `ok:false` without `SUPABASE_MANAGEMENT_TOKEN`, so
the egress figure is still zero. I will request it as a secret; if you prefer not
to issue one, the panel will show "not synced" instead of a wrong number.

### 2. Egress row in the quota panel
`DatabaseStoragePanel` declares `egress_bytes` in its type but renders nothing.
Add a row showing used / 4 GB budget / 5 GB cap, colour-coded at 80% of budget,
with the last-synced timestamp and the Auth / PostgREST / Storage / Realtime /
Functions split from `egress_breakdown`. When `egress_synced_at` is null, show a
muted "not synced — needs management token" state rather than 0%.
`QuotaStatusChip` picks up the egress percentage in its worst-of calculation.

### 3. Client-side full-row reads (step C)
Explicit column lists for the remaining `select("*")` reads:
- `market_pipeline_status` (SystemDataConfig)
- `market_api_settings` (BrokerConnectPanel)
- `market_saved_screeners` and the `market_stock_scores` branch in
  `src/lib/market/hooks.ts`
- `market_score_history` (`src/lib/market/scoreHistory.ts`)
- the heaviest list views in `src/lib/db.ts` (26 remaining `select("*")`):
  transactions, statements, emails, holdings, subscriptions — list rows render a
  handful of fields but currently ship statement text and parse payloads too.

### 4. Regression guard (step E)
- Dev-only response-size logger keyed by react-query key, so a heavy read is
  visible while building.
- Append the new 4 GB budget and the cadence table to
  `.lovable/free-plan-2026-07.md`, and a one-line entry in today's log.

## Order of work
1. Secret + panel egress row (makes the number visible).
2. `src/lib/db.ts` and market projections (largest remaining byte win).
3. Small config/broker projections.
4. Logger + notes.

## Technical notes
Files touched: `src/components/config/DatabaseStoragePanel.tsx`,
`src/components/hud/QuotaStatusChip.tsx`, `src/routes/config/SystemDataConfig.tsx`,
`src/components/market/BrokerConnectPanel.tsx`, `src/lib/market/hooks.ts`,
`src/lib/market/scoreHistory.ts`, `src/lib/db.ts`,
`.lovable/free-plan-2026-07.md`. No migration needed — the schema and cron
changes are already applied. Same data, fewer bytes.
