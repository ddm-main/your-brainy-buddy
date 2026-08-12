# Screener: fix wrong filter results and restore the live plane

## What I verified in the database just now

- **The live sweep has been failing every 5 minutes all day.** Every run for 2026-08-12 (49 so far, latest 12:25 IST) has `status = failed` with `error_message: "universe mismatch: run=1441 snapshot=1000"`, `priced_count = 0`.
- **So nothing has been published since yesterday.** Newest row in `market_live_prices` is dated 2026-08-11 08:15 UTC; the screener view therefore reports `quote_state = stale_live` / `eod` for every row.
- **That is why the filters look broken.** Filters evaluate the row's stored values, which are the *settled 2026-08-11* session: NAUKRI `change_pct_raw = +6.08`, DEVYANI `+6.91`, MATRIMONY `+11.81`, ROLEXRINGS `+14.19`. All genuinely pass "1D Return > 5%" — for yesterday. The table's Price and 1D Return cells, however, are repainted with today's Kotak tick (NAUKRI shows −0.89%). One number is filtered, a different number is displayed.
- **The mismatch vs Economic Times is a timestamp mismatch, not a threshold bug.** The ET capture is today's live intraday screen (NATIONALUM +7.55% today vs +1.38% settled yesterday; FINCABLES +7.30% today vs +14.16% yesterday).
- **The universe count is right but has real holes.** `market_stocks` has exactly 1441 in-universe rows and the view returns 1441. But TECHNOCRAFT, GUJIND, TAAZAINTL and JUBLAGRI (all in the ET result, all above ₹1,000 Cr) are absent from `market_stocks` *and* from `market_excluded_symbols` — they were never ingested, not deliberately excluded. NHIT is an InvIT and is correctly out.
- **Egress is still breaching the ceiling**: console shows `market_screener_rows (27c) → 142.5 KB` against the 128 KB budget.

## Root cause of the sweep failure

`buildSweepSnapshot` loads the universe through the `market_live_sweep_universe()` RPC over PostgREST, which caps a result set at 1000 rows, while `begin_market_live_sweep` counts the population in SQL and gets 1441. The guard that compares the two (correctly) refuses to promote, so the sweep dies before quoting a single symbol and the live plane freezes. The exact `snapshot=1000` figure is the cap, not a real universe.

## Fix plan

### 1. Unfreeze the live plane (the actual bug)

- Read the sweep universe in explicit pages (`.range()` loops of 1000) so the snapshot always holds the full 1441 symbols, and assert the paged count equals the run's `expected_count` before building.
- Keep the mismatch guard, but make it fail loudly with both counts and a "truncated read" hint, so a capped read can never again look like a universe change.
- Invalidate today's bad snapshot row so the next invocation rebuilds at the correct size, then force one sweep and confirm: one `complete` run, `priced_count` near 1441, fresh `market_live_prices.as_of`, and `quote_state = live` across the board.

### 2. Never filter one number while showing another

- In Live mode, the Price / 1D Return / Volume cells must render the same values the filters evaluated (the promoted sweep row). The sub-minute tick overlay stays, but only as a visibly-marked "newer than the filter plane" indicator — it may not silently replace the filtered value.
- When the live plane is stale (as today), the screener must say so at the top of the results and label the run as settled-session parity for the date in force, instead of quietly mixing yesterday's filter basis with today's ticks.

### 3. Close the universe holes

- Reconcile `market_stocks` against the current NSE EQ master, add the legitimately missing names (TECHNOCRAFT, GUJIND, TAAZAINTL, JUBLAGRI and any others the diff finds) with their caps, and leave non-equity instruments such as NHIT out by rule.
- Anything intentionally excluded must appear in `market_excluded_symbols` with a reason, so "missing" and "excluded" are always distinguishable.
- Keep the screener strictly on the in-universe, non-penny set — no widening.

### 4. Keep egress low

- Live mode polls on the 5-minute sweep cadence only; no extra full-universe reads.
- Keep the paged 600-row reads and narrow projections, and drop the current page size until a single `market_screener_rows` response is under the 128 KB ceiling (the 142 KB responses in the console go away).
- The universe/anchor snapshot is still built once per session; the paging change adds one extra small read per session, not per sweep.

### 5. Verify parity properly

- After the plane is live, capture ET and this screener at the same minute with the same four filters, using ET's `'000` volume unit, and produce a symbol-by-symbol diff.
- Every residual difference must have a named cause (ET's BSE/consolidated basis, an InvIT/SME excluded by policy, or insufficient 30-day history) — not an app filtering artefact.

## Technical notes

- Edge functions: `_shared/market/sweepSnapshot.ts` (paged universe read, count assertion), `market-live-sweep` (clearer failure, snapshot invalidation).
- Frontend: `src/routes/market/Screener.tsx` (overlay vs filter-basis honesty, stale-plane banner), `src/lib/market/screenerRun.ts` (page size / projection tuning).
- Data: one reconciliation pass on `market_stocks` / `market_excluded_symbols`, then refresh the screener snapshot. No settled prices, holdings, orders or user data are deleted.
