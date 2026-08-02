# Egress pass 2 — drive the monthly total well under 4 GB

The cycle is at 5.00 / 5 GB, but the daily chart already shows the effect of the
1 Aug work: 30 Jul was 1.2 GB, 1 Aug is roughly 100 MB. The damage for this
cycle is done; the goal now is a durable floor of ~60–100 MB/day.

## What is already in place (verified in code today)

- Screener: explicit column projection (no `score_components` / `data_provenance`
  blobs), server-side universe narrowing, 15 min `staleTime`, no refetch on
  focus/mount, and the v4 merge only pulls three fields.
- Most market hooks use `liveInterval(...)` with `refetchIntervalInBackground: false`;
  dashboard quotes are at 3 s, not 1 s.
- Realtime tick channel unsubscribes after 60 s hidden.
- Archive drain is hourly; duplicate screener-snapshot job removed.

So the remaining spend is spread across three smaller sources, not one big one.

## Remaining work

### 1. Ungated pollers (client, runs whether or not the tab is visible)
These still lack visibility gating / off-hours backoff:
- `gttHooks` GTT list — 15 s during market hours, no background gate.
- `autotradeHooks` — two 15 s pollers (log + fills), fixed interval, run 24/7.
- `feedStatus` — 30 s, always on.
- `selftest` — 120 s / 300 s / 300 s, always on, admin pages only.
- `Screener` pipeline status — 60 s, `select("*")`.

Fix: route all of them through the existing `liveInterval` helper, add
`refetchIntervalInBackground: false`, and stop polling entirely when the market
is closed (single fetch on mount instead).

### 2. Full-row reads outside the market screener
`select("*")` still ships every column on: `market_autotrade_settings`,
`market_autotrade_rules`, autotrade log/fills (100 rows each, 15 s), backtest
runs and results, `market_pipeline_status`, plus the whole finance/JARVIS layer
in `src/lib/db.ts` (transactions, holdings, subscriptions, emails).

Fix: explicit column lists for the polled market tables first (they repeat every
15 s), then the finance list views that load large tables (`transactions`,
`emails`, `investment_holdings`), where only a handful of fields are rendered.

### 3. Cron / edge-function egress (81 MB on the worst day)
Current schedule has several jobs running far more often than their data changes:
- `market-score-backfill-drain` — every 5 min, 24×7, including weekends.
- `market-selftest` — every 10 min during market hours *plus* hourly all day.
- `market-tick-bars-1m` — every minute 3–10 UTC (keep, but confirm delta writes).
- `market-history-backfill` — hourly 11–23 UTC, 7 days a week.
- `market-news-sync` — hourly on weekdays.

Fix: weekday/market-hours windows for the drains, selftest to hourly only,
history backfill to a nightly window (it is a backlog drain, not a live feed),
and news to 3×/day. Each job also returns a JSON body to `net.http_post` —
trim those response payloads to a status line.

### 4. Auth egress (26 MB/day, 2.1%)
Disproportionate for four users: it means token refresh is firing very often
across many open tabs/isolates. Check the Supabase client's `autoRefreshToken`
behaviour against how many clients the app instantiates, and confirm edge
functions are not calling `auth.getUser()` per request where the JWT could be
verified locally.

### 5. Measurement so this does not silently regress
- Dev-only wrapper that logs response bytes per query key, so a heavy read is
  visible while building.
- Surface the current cycle's egress in the existing quota panel (needs the
  Supabase Management API wired to a small scheduled function, since egress is
  not readable from Postgres).

## Order of work
1. Cron schedule cuts (server-side, zero UI risk, immediate effect).
2. Ungated pollers + column projections on the 15 s market queries.
3. Finance/`db.ts` projections.
4. Auth-refresh investigation.
5. Measurement panel.

## Technical notes
Files: `src/lib/market/gttHooks.ts`, `autotradeHooks.ts`, `feedStatus.ts`,
`selftest.ts`, `src/routes/market/Screener.tsx`, `src/routes/market/Backtesting.tsx`,
`src/lib/db.ts`, one migration for the `cron.job` schedule changes, and
`src/components/config/DatabaseStoragePanel.tsx` for the egress readout.
No behaviour change intended: same data, fewer bytes and fewer requests.
