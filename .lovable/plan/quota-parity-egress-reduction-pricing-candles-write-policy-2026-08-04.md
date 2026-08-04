# Quota parity + egress reduction (pricing/candles write policy)

## What I verified just now

- **Egress meter only sees browser tabs.** `system_egress_daily` for today holds
  **5.57 MB / 118 requests** (postgrest) + 0.01 MB (functions). Supabase reports
  ~100 MB–1.2 GB/day. The gap is not a bug in the panel: `src/lib/egressMeter.ts`
  wraps `window.fetch`, so **nothing server-side is counted** — every cron job and
  edge function reading PostgREST with the service key is invisible, and so is
  every tab that is signed out or closed before the 60 s flush.
- **The meter also under-counts what it does see**: it measures the *decompressed*
  body via `arrayBuffer()`, while Supabase bills wire bytes (gzip body + headers),
  and it drops realtime WebSocket frames and SSE bodies entirely.
- **Disk / storage are close but not identical**: `quota_report()` computes
  `db_bytes` as `sum(pg_database_size(...))` (418.1 MB) vs Supabase's 438 MB — the
  Supabase figure includes WAL and non-database instance files. Storage is
  26.2 MB vs 25 MB (Supabase reports base-10 MB, panel uses MiB). Both columns
  for the authoritative number (`db_reported_bytes`, `egress_reported_bytes`)
  already exist in `system_quota_state` and are unused.
- **Every intraday chart read writes to the DB.** `market-candles` upserts the
  fetched series into `market_intraday_prices` (line ~796) and
  `market_daily_prices` (line ~478) on *every* request, plus a
  `market_provider_health` insert per call — so a chart open at a 5 s poll writes
  continuously. This is the "saving price data every few seconds" you flagged.
- **Quote cadence**: `useQuotes` defaults to a **1 s** poll during market hours;
  Dashboard's score-quote overlay passes `intervalMs: 1_000`, and its own
  positions query polls at 3 s. Only `refetchIntervalInBackground:false` gates
  it — a visible-but-unfocused window keeps polling at full rate.
- **The candle delta cursor already exists** (`since` → `partial` → client-side
  merge), so that part of the ask is done; what is missing is applying the same
  idea to the *write* side and to the daily/weekly series.
- Cron `market-tick-bars-1m` runs every minute 3–10 UTC calling
  `market-tick-bars`, and **no such edge function exists in the repo** — it is
  posting into a 404 sixty times an hour.

## The plan

### 1. Make the counters match Supabase

- **Server-side egress metering.** Add a shared wrapper in
  `supabase/functions/_shared/market/` that all edge functions use for their
  Supabase client, recording response bytes into `system_egress_daily` under
  sources `postgrest:server` / `functions:server`, keyed by function name. Then
  the panel's total covers cron + edge traffic, which is where the missing GBs
  are.
- **Bill-accurate byte counting on the client.** Prefer the
  `content-length`/`Content-Encoding` of the response over the decompressed
  length, add a fixed per-request header overhead, and meter realtime frames.
- **An authoritative anchor.** Add an admin input in the quota panel to enter the
  Supabase-reported cycle egress and disk size (writing `egress_reported_bytes`
  and `db_reported_bytes`). The panel then shows *measured* vs *reported* side by
  side plus the drift ratio, and the governor uses the reported figure when it is
  present. This is the only way to stay honest, since Supabase no longer exposes
  the number over an API.
- **Disk/storage parity**: display Supabase-style base-10 units, show WAL/instance
  overhead as the difference between `db_bytes` and `db_reported_bytes`, and label
  each row with its source so 418 vs 438 is explained rather than mysterious.

### 2. Stop persisting live pricing and candles

Broker APIs are the source of truth intraday; the DB only needs settled data.

- `market-candles` **stops upserting on read** by default. Writes happen only when
  (a) the request is the first fill for a symbol/timeframe that has no stored
  bars, (b) the bar is closed and older than the last stored bar (backfill of a
  real gap), or (c) the caller is a cron/EOD job. Forming bars are never written.
- Reads become **DB-first, provider-on-miss**: on section load, serve stored bars,
  and only call the broker for the missing tail — then persist that tail once.
- Drop the per-request `market_provider_health` insert to a sampled/errors-only
  write.
- Settled data keeps its existing writers (`market-pipeline-eod`,
  `market-daily-sync`, bhavcopy syncs) — nothing about EOD correctness changes.
- Unschedule the dead `market-tick-bars-1m` cron (or restore the function if the
  1-minute bars are wanted; currently it does nothing but burn a request/min).

### 3. Poll cadence

- `useQuotes` default 1 s → **5 s** while open and focused, **15 s** when the
  window is blurred (not just hidden), single fetch when closed. Dashboard's
  3 s positions poll follows the same rule.
- Same focus-aware backoff for the depth ladder, indices strip and the intraday
  candle poll (5 s focused → 20 s blurred).
- Symbols the Kotak WebSocket relay already pushes get their REST poll dropped to
  a keep-warm interval, since the push tick already wins in the merge.

### 4. Prove it

- Re-run the panel after a trading session and compare measured vs the
  Supabase-reported number entered in step 1; target drift under ~20%.
- Confirm chart correctness after the write-policy change: the same series shows
  on open, with the forming bar coming from the quote path.

## Technical notes

Files: `src/lib/egressMeter.ts`, `src/components/config/DatabaseStoragePanel.tsx`,
`src/lib/market/hooks.ts`, `src/routes/market/Dashboard.tsx`,
`supabase/functions/market-candles/index.ts`,
`supabase/functions/_shared/market/*` (new metered client, `egress.ts`),
plus one migration for the reported-figure columns/RPC and the
`market-tick-bars-1m` unschedule. No change to EOD/settled data pipelines.
