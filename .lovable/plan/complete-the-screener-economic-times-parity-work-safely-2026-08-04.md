# Complete the Screener ↔ Economic Times parity work safely

## Verified current state

- The database pieces exist: `market_live_prices` and the `market_screener_rows` live-price join are present.
- The source for `market-live-sweep` exists, but the deployed endpoint returns **404**, has no logs, and `market_live_prices` contains **0 rows**. The source for `market-close-snapshot` also returns **404**.
- No live-sweep cron job is registered. The five-minute plane is therefore inactive, and the Screener falls back to split EOD rows (1,568 rows dated 2026-08-04 and 1,222 dated 2026-08-03).
- The live app still uses two client quote paths, a 1,000-candidate cap, exact-session exclusions, the per-row `STALE` label, and EOD volume display. The authenticated check loaded 2,800 rows over three large responses and showed `FILTERS · EOD`; no browser errors occurred.
- The daily candle writer now applies the settlement guard. This part is complete.
- The universe has 2,800 active NSE EQ symbols, but only 1,586 pass the default liquidity visibility rule. Symbol reconciliation and the promised ET fixture verification are not complete.

## Implementation plan

### 1. Make a coherent live plane, not a partially overwritten table

- Change live-price storage to retain a bounded staging sweep and a separately marked **active completed sweep**. A running sweep must never replace values visible to the Screener until all universe batches finish.
- Carry one `sweep_id`, `session_date`, and `as_of` through every chained invocation. The current source creates a new `as_of` in each invocation, so that will be fixed.
- Track expected, priced, failed, Kotak, and Yahoo counts per sweep. Promote only a sweep that reaches the required universe coverage; keep the previous completed sweep active if a run fails.
- Retain the last completed sweep for rollback and prune older staging rows. This keeps growth bounded while protecting the last known-good plane.
- Resolve `prev_close` from the latest authoritative settled daily price per symbol, not from a potentially stale screener snapshot. Compute 1D return only from that anchor.

### 2. Deploy and exercise the missing functions before scheduling them

- Deploy `market-live-sweep` and `market-close-snapshot`, then invoke each manually with a small safe batch and inspect response/logs.
- Run a complete forced sweep and verify: one active sweep, one shared timestamp, coverage across the active NSE EQ universe, valid previous-close anchors, provider counts, and no writes into settled daily tables.
- Make upstream failure explicit. If Kotak is unavailable and Yahoo cannot cover the remaining universe, fail the sweep without promoting partial data.

### 3. Register production schedules only after the full sweep passes

- Schedule five-minute sweeps for the NSE session, a pre-open seed, and a final post-close sweep.
- Register the guarded post-close snapshot and retain the existing bhavcopy settlement/re-score flow.
- Use the existing secret-verified cron invocation path; do not place service-role credentials in SQL, browser code, or logs.
- Add overlap protection so a slow sweep cannot race the next five-minute run.

### 4. Make the Screener use one source for filtering and rendering

- Live mode will read the latest **completed** server plane for Price, 1D Return, Volume, and Volume > 30D Avg. Filtering and cells will consume the same row values.
- Remove the candidate-wide client quote/filter pass, the 1,000-symbol correctness cap, and the duplicate visible-page REST map as filtering sources. Optional push ticks may remain presentation-only and must be visibly identified as newer than the five-minute filter plane.
- Keep EOD mode on the latest settled bhavcopy-backed session. Back-date mode remains separate and clearly dated.
- Remove the per-row `STALE` label and split-session exclusion banner in live mode. Replace them with one status chip showing mode, active sweep time, age, coverage, and provider counts; show `no quote` only for symbols absent from the active sweep.
- Display live volume from the same plane used by volume filters and add the shares / `'000` unit toggle without changing filter units.
- Stop default liquidity hiding from being mistaken for missing market coverage: keep the toggle, but state the number intentionally hidden.

### 5. Reconcile the market universe without inventing securities

- Diff `market_stocks` against the current NSE EQ master and settled bhavcopy universe.
- Resolve missing/renamed/delisted symbols through corporate-action history before inserting anything. In particular, verify the requested GLS/Glenmark Life identity against the current NSE master rather than blindly adding an obsolete ticker.
- Add the same universe-gap check to market validation, with counts for missing, renamed, inactive, and unsupported symbols.

### 6. Prove parity at a shared timestamp

- Add regression tests for atomic sweep promotion, shared timestamps, failed-sweep rollback, settled-anchor 1D math, provider fallback, overlap protection, and forming-bar rejection.
- Add UI tests proving Price, 1D Return, and Volume display exactly the values that passed their filters, including more than 1,000 candidates.
- Re-run the specified screen (`Price > 100`, `MCap > ₹1,000 Cr`, `1D > 8%`, `Volume > 30D Avg`) against ET at the same captured timestamp and volume unit. Produce a symbol-by-symbol diff with a named cause for every residual mismatch.
- Verify authenticated desktop rendering, request sizes, function logs, cron state, and database lint findings before calling parity complete.

## Data-safety rules

- No destructive rewrite of settled prices, scores, holdings, or user data.
- Every schema change is additive or reversible; the current completed plane remains available until its replacement is verified and promoted.
- Failed or partial sweeps never become visible.
- Before cleanup, compare row counts/checksums and retain a rollback sweep. Any obsolete live-plane structures are removed only after the app and cron have run successfully on the replacement.

## Completion criteria

- A deployed five-minute job continuously produces one complete, atomic live plane for the active NSE EQ universe.
- Live filters and displayed Price / 1D Return / Volume use that exact plane with no candidate cap or split-session exclusion.
- EOD remains bhavcopy-settled and forming bars cannot enter it.
- The benchmark ET screen is reconciled stock-by-stock at the same timestamp, with no unexplained data differences.