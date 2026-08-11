# Cut PostgREST egress: watched-symbols sweep + a real 1 MB ceiling

## What today's meter actually shows (2026-08-11, measured)

You opened the app once. Your browser accounted for ~250 KB. Everything else is
server-side:

| Route | Requests | Bytes | Per fetch |
|---|---|---|---|
| `market-live-sweep` → `market_sweep_snapshot` chunk | 223 | 14.5 MB | 63 KB |
| `market-live-sweep` → `market_daily_prices` (5c) | 1,016 | 1.96 MB | 1.9 KB |
| `market-live-sweep` → `market_api_settings` (17c) | 220 | 825 KB | 3.7 KB |
| `market-autotrade-eval` → `market_api_settings` (16c) | 213 | 795 KB | 3.6 KB |
| `market-archive-prices` → storage objects | 2,019 | 782 KB | 0.4 KB |
| `market-live-sweep` → `market_universe` (6c) | 2 | 245 KB | 108-131 KB (over budget) |

One cause dominates: the five-minute sweep walks the whole ~3,000-symbol NSE
universe. The session snapshot removed the per-chunk `market_stocks` reads, but
each cold chunk invocation still downloads its own 63 KB slice — ~380 KB per
sweep, ~75 sweeps a day.

## 1. Sweep only what you watch (14.5 MB → ~1 MB/day)

Build the live sweep universe from symbols that actually matter:

- watchlist items, holdings, open positions, GTT and alert targets,
  active autotrade rules, and the index members shown on the dashboard.

Typically 200-400 symbols — one or two chunks per sweep instead of six, and the
snapshot slice shrinks proportionally. Full-universe prices keep coming from the
end-of-day pipeline, which is where the screener and scores already read from,
so nothing on screen loses data. Symbols added to a watchlist mid-session are
picked up on the next sweep (the snapshot is rebuilt when the watched set
changes, detected by a cheap hash rather than a full re-read).

## 2. Stop re-reading the settings row on every invocation (~1.7 MB/day)

`market_api_settings` is pulled 460+ times a day at 3.6-3.7 KB because the row
carries encrypted token blobs. Two changes: project only the fields each caller
uses (the sweep needs a handful, not 17), and memoise the row per isolate for
its warm lifetime with a short TTL.

## 3. Trim the remaining per-chunk chatter

- `market_daily_prices` (5c) is read 1,016 times per day by the sweep for data
  the snapshot already resolves as anchors — fold it into the snapshot.
- `market-archive-prices` issues 2,019 storage reads and 673 delete/insert
  round-trips per run; batch the archive writes and skip re-reading objects it
  just wrote.
- Set `Prefer: return=minimal` as the default on the service client so writes
  stop echoing rows back; calls that chain `.select()` override it per request.

## 4. A ceiling that is enforced, not just labelled

Today anything over 1 MB is tagged `!1MB` in the route label and allowed
through. Instead:

- **Browser**: a fetch whose projected size exceeds 1 MB opens an approval
  dialog naming the size, the table, the columns and why it is being fetched.
  Approve to continue, decline to abort. Approvals are remembered per route for
  the session so it never nags twice.
- **Server**: a response over 1 MB is refused — the read throws, the route is
  written to `system_maintenance_log`, and the job reports the failure instead
  of silently paying for it. Server code must page under the ceiling.
- Estimation before the fetch uses the measured bytes-per-row history in
  `system_egress_daily` for that route, so the prompt appears before the
  download, not after.

## 5. Keep it honest

Daily maintenance flags any route whose average bytes-per-request crosses 1 MB
or whose daily total crosses a per-route budget, as a row in
`system_maintenance_log` surfaced in the quota panel.

## Expected result

Idle day (app opened once): from ~20 MB to roughly 3-4 MB. Background jobs keep
running on their current schedule, as you asked.

## Technical notes

- Files: `supabase/functions/_shared/market/sweepSnapshot.ts` (watched-set
  universe + anchors folded in), `supabase/functions/market-live-sweep/index.ts`,
  `_shared/market/common.ts` (Prefer header, settings cache),
  `market-archive-prices/index.ts`, `_shared/market/serverEgress.ts` (hard
  ceiling), `src/lib/egressMeter.ts` plus a small approval dialog component.
- One migration: a `system_maintenance_log` warning path for ceiling breaches;
  no table shape changes to market data.
- Verification: re-read `system_egress_daily` grouped by route after one full
  session and confirm no route carries `!1MB` and the sweep's snapshot route is
  under ~1 MB/day.
