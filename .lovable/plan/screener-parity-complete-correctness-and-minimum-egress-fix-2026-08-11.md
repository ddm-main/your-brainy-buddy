# Screener parity — complete correctness and minimum-egress fix

## Verified diagnosis

- The promoted live plane stopped at **13:45 IST** with 1,821 rows. Later five-minute runs priced only **169 symbols** and failed promotion against 1,710–2,656 expected symbols.
- The full-universe RPC now returns **2,656 active, non-penny NSE mainboard symbols**, but today's persisted `market_sweep_snapshot` still contains the old **169-symbol watched set** (`chunk_size=200`, one chunk). The session-long snapshot reuse preserved the obsolete population after the universe logic changed.
- The stale plane directly excludes later ET movers: at 13:45 our Unichem, TCPL Packaging and Finolex Cables were −0.61%, −0.15% and +0.16%; ET's later capture shows them above the 5% threshold.
- The app's current stored values produce exactly **35** strict matches, so threshold inclusivity is not the discrepancy (`>` versus `>=` still gives 35).
- The browser has two additional false-exclusion paths: the static query is filtered and cached for six hours, then the final merge only maps over those static rows. A symbol that qualifies later in the live query cannot enter the result. Exact-session checks can also reject a valid live row based on its static `trade_date`.
- The board is structurally incomplete: 2,802 active NSE EQ symbols exist, but 1,057 are absent from the screener snapshot and 65 still have no score. Matrimony.com and OM Infra currently have only one daily bar, so they cannot yet produce a valid 30-day average.
- Reference corruption is confirmed: the live plane contains impossible 90%–2,600% changes from stale anchors. Cupid's displayed cap and average volume are also inconsistent with external/reference fundamentals.
- Measured egress confirms avoidable costs: the obsolete 169-symbol snapshot was read 258 times for **15.9 MB**, while normal screener responses still breach the 128 KB ceiling at roughly **170–219 KB**.

## Fix plan

### 1. Make one population authoritative for the entire sweep

- Define the sweep population once: active NSE EQ, non-SM/ST, non-penny, with watched symbols used only for ordering.
- Use that exact population for snapshot contents, `expected_count`, promotion numerator, coverage reporting and full-plane pruning.
- Remove the silent `expected_count` overwrite. If the snapshot count and run count ever differ, fail before quoting and log both counts.
- Track the `market_universe` view in migration history or point the RPC directly at `market_stocks`; do not depend on out-of-band schema state.

### 2. Version and invalidate the session snapshot correctly

- Add a snapshot schema/universe version to the fingerprint, alongside symbols and chunk size.
- Rebuild when code/schema version, symbol set, eligibility flags or chunk size changes—even within the same session.
- Delete today's obsolete 169-symbol snapshot once so the next invocation builds the 2,656-symbol, 400-row chunks.
- Validate every decoded chunk against stored `symbol_count`/`chunk_count`; never promote a partial or legacy payload under a full-universe denominator.

### 3. Restore continuous full-universe live publication

- Keep one `sweep_id` and `as_of` through all chained chunks and promote only after the final authoritative chunk.
- Count a symbol as priced only when it has a valid current quote and settled anchor. Keep the previous published plane intact on a genuinely failed sweep.
- Preserve watched-first ordering, 400-symbol chunks and batched broker calls; Yahoo remains a bounded gap filler.
- Replace the fixed ±21% rejection with an anchor-integrity check: verify suspicious moves against feed previous-close/current-session data before rejection. This removes phantom 100%+ movers without discarding legitimate circuit-limit stocks.

### 4. Make server filter pushdown live-safe

- Do not apply intraday fields (`close`, 1D change, volume) to the six-hour static-plane query. Apply them to the five-minute live candidate query; keep only genuinely static predicates such as settled fundamentals in the static query.
- Build the final candidate set as the **union** of static and live keys, then hydrate and run the existing client predicate as the final authority.
- A live row may therefore enter after crossing a threshold; a cached morning static result can no longer suppress it.
- Keep null-inclusive pushdown as a correctness-preserving superset and retain explicit full-universe paging only for export/load-all.

### 5. Make freshness mode-aware

- In Live mode, trust the promoted sweep's `session_date`, `quote_state` and age for Price / 1D / Volume predicates; do not reject a valid live row because its static score date differs.
- In EOD mode, keep the settled-session coverage resolver and exact-session rule unchanged.
- Show `unknown/no quote/no 30D history` separately from a real filter failure, including excluded counts and symbols.

### 6. Complete the screener universe without inventing data

- Rebuild `market_screener_snapshot` from the current score/live source after today's stale 2026-08-07 snapshot is retired.
- Backfill bounded batches for the 65 symbols with no score and the eligible non-penny/liquid symbols absent from the snapshot.
- For new listings such as Matrimony.com and OM Infra, keep `Volume > 30D Avg` as unknown until sufficient settled history exists; never synthesize a 30-day average.
- Report exclusions by reason: no score, insufficient history, no quote, penny, SME or inactive.

### 7. Repair and continuously audit reference values

- Recompute previous-close anchors from the latest settled session and invalidate stale corporate-action anchors.
- Audit market cap against reported cap and shares × live price; audit 30-day volume against the settled daily series and robust outlier bounds.
- Correct the underlying shares/history rows for confirmed offenders (starting with Cupid and Gujarat Natural), then rescore and refresh the snapshot.
- Quarantine impossible rows from live filtering with a named validation reason rather than silently showing or dropping them.

### 8. Preserve results while reducing egress

- Build the compact, columnar universe/anchor/token snapshot once per valid session version; read one JSON chunk per invocation.
- Raise the warm chunk memo slightly past the five-minute cadence and key it by snapshot version, so reuse is safe and repeated identical reads disappear.
- Match the live query cache/poll interval to the five-minute publication cadence; stop the guaranteed redundant four-minute refresh.
- Key the static browser cache by settled session/version, not wall-clock TTL alone. Cache index membership by version as well.
- Keep projections narrow, server ordering/pagination intact, minimal write responses, and add production telemetry when an unmapped field forces a full projection.
- Do not implement slower polling for potentially untraded tails or change-only stage omission until equivalence tests prove coverage and volume semantics unchanged.

## Validation

1. Trigger a fresh full-universe sweep and confirm approximately 2,656 snapshot symbols across seven 400-row chunks, one sweep timestamp, successful promotion and single-digit-minute age.
2. Compare snapshot symbols, run `expected_count`, valid staged symbols and promoted symbols; every difference must have a named validation reason.
3. Run the four filters against the unoptimised full query and the optimised two-plane path; assert identical symbol sets.
4. Capture ET and this screener at the same minute and produce a symbol-by-symbol diff. Remaining differences must be attributable to timestamp, ET universe policy, insufficient 30-day history or provider data—not app filtering.
5. Test a symbol crossing 5% after the static cache was populated, a live row with an older score date, a missing 30-day average, a genuine 20% circuit move and a bad corporate-action anchor.
6. Re-read `system_egress_daily` after a full trading session: no normal screener response above 128 KB, no repeated whole-snapshot reads, and no correctness difference from the full-query control.

## Technical scope

- Database: tracked authoritative universe definition; aligned begin/promote functions; snapshot version/invalidation; bounded snapshot refresh/backfill and reference-data corrections.
- Edge functions: `market-live-sweep`, `_shared/market/sweepSnapshot.ts`, and `market-data-validation`.
- Frontend: `src/lib/market/screenerRun.ts`, `src/lib/market/screenerCatalog.ts`, screener diagnostics/status, and focused regression tests.
- No settled-price history, holdings, orders or user data is deleted. Only disposable sweep/screener snapshots and confirmed corrupt reference rows are rebuilt.