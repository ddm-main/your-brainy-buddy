# Quota parity + egress reduction — status check and the remaining work

## What is already implemented (verified in the code and DB just now)

- **Server-side egress metering — done.** `supabase/functions/_shared/market/serverEgress.ts`
  patches the isolate's `fetch`, counts Supabase response bytes, and flushes through
  `record_egress`; `svcClient()` in `_shared/market/common.ts` installs it on every
  market edge function. Server routes are labelled `srv:<path>` (rather than the
  `postgrest:server` source name the plan proposed) — the panel totals both.
- **Bill-accurate client counting — done.** `src/lib/egressMeter.ts` now prefers
  `content-length`, applies a gzip estimate plus a 220-byte header allowance, and
  meters Supabase realtime WebSocket frames.
- **Reported-figure plumbing — partly done.** `set_quota_reported(_egress_bytes, _db_bytes)`
  exists and is granted to `authenticated`/`service_role`; `db_reported_bytes` and
  `egress_reported_bytes` are read by `DatabaseStoragePanel.tsx`. **No admin input
  exists yet** to write them, so both stay null and the drift comparison never shows.
- **Candle write policy — done.** `market-candles` persists intraday bars only for a
  first fill or for closed buckets newer than the newest stored `ts`; forming buckets
  are never written. Daily bars filter to settled sessions.
- **Poll cadence — done.** `src/lib/market/hooks.ts` has a `liveInterval` helper with
  focus-aware backoff (`BLURRED_MIN_MS = 15_000`); `useQuotes` defaults to 5 s focused
  / 15 s blurred, and the depth, indices and candle hooks use the same helper.

## What is still remaining

1. **`market-tick-bars-1m` cron is still active** (`* 3-10 * * 1-5`) and there is no
   `market-tick-bars` function in the repo — 60 requests/hour into a 404.
2. **No admin input for the Supabase-reported figures**, so the measured-vs-reported
   drift row and the reported-first governor behaviour are unusable.
3. **Disk/storage parity presentation** (base-10 units, WAL overhead shown as
   `db_reported_bytes − db_bytes`, per-row source labels) not done.
4. **`market_provider_health` still gets one insert per candle request** on the daily
   route — not yet sampled/errors-only.

## New requirement: quotes are Kotak-only, fast, never persisted

Today `market-quotes` is not a thin broker passthrough. Per poll it also:
- reads `market_daily_prices` for an EOD previous-close anchor (chunked `IN` queries),
- reads corporate actions to guard that anchor,
- can insert into `market_value_audit` when the live price disagrees with the cached
  close by more than the sanity threshold,
- stamps a throttled feed heartbeat row,
- falls back to Yahoo, then to the cached daily close (`source: "cache"`), which is
  what surfaces as "delayed · yahoo" in the UI.

That is the real reason quotes feel slow and still generate database traffic.

### The change

- **Broker-only quote path.** The live quote route resolves Kotak (system feed session)
  and returns its ticks. If Kotak cannot answer, respond with an explicit
  `provider: "kotak"`, `stale: true` and a reason — no silent Yahoo substitution and no
  cached-close substitution on the live path. Yahoo stays where it belongs: EOD/history
  pipelines and the explicit off-session view.
- **Zero writes on the quote path.** Remove the per-poll `market_value_audit` insert
  (move the disagreement check to the post-close validation job that already exists) and
  make the heartbeat write once per isolate per minute at most, or drop it from the
  quote route entirely and derive liveness from the response itself.
- **Zero reads on the quote path.** `previous_close` comes from the broker tick.
  Where the broker omits it, the frontend uses the previous close it already has on the
  screener/holdings row (from the EOD snapshot it loaded once) instead of the function
  re-querying `market_daily_prices` on every poll.
- **Push first, REST as keep-warm.** Symbols the Kotak WebSocket relay is already
  pushing get their REST poll dropped to a long keep-warm interval, since the push tick
  wins the merge anyway.
- **Surface the truth in the UI.** The screener/dashboard chip shows `live · kotak`,
  `push · kotak`, or `kotak session expired — reconnect` (opening the existing
  `KotakReconnectModal`). It never claims a Yahoo number is a live price.

## Order of work

1. Unschedule `market-tick-bars-1m`.
2. Rework `market-quotes` into the broker-only, read-free, write-free path above.
3. Frontend: previous-close from the loaded EOD row, push-aware REST backoff, honest
   provider chip and reconnect affordance.
4. Sample `market_provider_health` writes in `market-candles`.
5. Quota panel: admin inputs calling `set_quota_reported`, measured-vs-reported drift
   row, base-10 units and per-row source labels.
6. Verify: watch a session with `__egress()` and the panel, confirm quote latency comes
   down and that a trading-hours chart open produces no repeated intraday upserts.

## Technical notes

Files: `supabase/functions/market-quotes/index.ts`,
`supabase/functions/_shared/market/{provider,heartbeat}.ts`,
`supabase/functions/market-candles/index.ts`, `src/lib/market/hooks.ts`,
`src/routes/market/{Screener,Dashboard}.tsx`,
`src/components/config/DatabaseStoragePanel.tsx`, plus one `cron.unschedule` statement.
No change to EOD/settled pipelines or to scoring.

## Open question

When the Kotak session is down during market hours, should the quote cells show the
**last known broker tick with a stale marker**, or **dashes with a reconnect prompt**?
The plan above assumes the stale-marked last tick, with no Yahoo number ever shown as live.
