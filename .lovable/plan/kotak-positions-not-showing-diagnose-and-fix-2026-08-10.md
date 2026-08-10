# Kotak positions not showing — diagnose and fix

## What I verified against the live system

- `market_positions` is **empty** (0 rows, open or closed) — so this is a write problem, not a display problem.
- The schema is fine now: `product` column exists, both broker unique indexes exist, grants and RLS on `market_positions` are correct, and a signed-in read of `id,symbol,product` returns `200 []` (no schema-cache or permission error).
- The broker side is fine: the account self-test probe at 06:25 UTC recorded **`kotak_neo / positions → ok, "4 positions"`**, and that probe runs through the exact same mapper (`getPositionsDetailed`) the sync uses. So Kotak returns the 4 positions and they map to 4 rows.
- Holdings sync from the same Kotak session wrote successfully at 06:33 UTC (`RELAXO`, source `kotak_sync`), so the session, provider resolution and DB writes all work for the sibling surface.
- Edge function logs and the analytics log tables return nothing for this project, so I cannot see whether `market-sync-positions` was invoked or what it returned. **The exact failure point is therefore still unconfirmed** — the first step below is to confirm it, not to guess.
- Nothing in the app auto-syncs positions: `useMarketAutoSync` only calls `market-daily-sync`; positions are only written when the Positions/Portfolio "sync" button is pressed.

## Step 1 — Reproduce and capture the real error (first thing I do)

Invoke `market-sync-positions` for the signed-in account and read the full JSON response (`inserted`, `updated`, `total`, `errors`, or the 4xx/5xx message). Three outcomes, each with a known fix:

- `total: 0` → the mapper dropped the rows in the sync path; compare the raw Kotak envelope against the probe payload and fix the mapping/filter that discards them.
- `total: 4` with `errors[...]` → a write error; fix whatever Postgres reports (column, enum, constraint).
- HTTP 400/502 → provider resolution or broker call failed in the sync path only; fix that branch.

I will report the actual response before changing behaviour.

## Step 2 — Fix the confirmed cause

Apply the targeted fix in `supabase/functions/market-sync-positions/index.ts` and/or the Kotak positions mapper in `supabase/functions/_shared/market/provider.ts`, then re-run the sync and confirm 4 rows land in `market_positions` with the right symbol, qty, avg price and side (BEML 5, PAYTM 5, SKYGOLD 10, SYRMA 10 — all NSE, CASH/CNC).

## Step 3 — Stop this class of failure from being invisible

- **Auto-sync on open**: Positions and Portfolio Overview trigger a positions sync on mount (throttled, e.g. once per 2 minutes per tab) instead of waiting for a manual click, matching what a user expects when the broker shows 4 positions.
- **Loud failures**: when the broker reports N positions and the app writes 0, show a red inline banner on the Positions and Portfolio cards with the actual reason, not a silent zero. (Today's warning toast is easy to miss and the card just reads "OPEN 0".)
- **Debug echo**: `market-sync-positions` accepts `{ debug: true }` and returns raw broker row count vs mapped row count vs written count, so any future divergence between "probe says 4" and "table says 0" is one call away from an answer.

## Technical notes

- No schema migration is expected; the earlier `product` + unique-index migration is already applied.
- No UI redesign — only a banner and the mount-time sync trigger on `src/routes/market/Positions.tsx` and `src/routes/market/PortfolioOverview.tsx`.
- The realized-P&L path (`market_realized_pnl_daily`, currently empty) is covered by the same sync and will be verified in Step 2.
