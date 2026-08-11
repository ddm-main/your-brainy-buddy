# Screener parity and minimum-egress repair

## Verified current failures

- The latest live run at **15:35 IST** expected **2,656** eligible symbols but scanned and priced only **169**, so promotion failed at **6.36%**. The published live plane is still frozen at **13:45 IST** with 1,821 rows.
- The database universe function already defines 2,656 active NSE EQ mainboard, non-penny symbols, but runtime telemetry still shows the old watched-universe route and 169-symbol behavior. The deployed edge function and current source/database contract are not in sync.
- No valid `market_sweep_snapshot` exists now. The intended seven 400-symbol chunks were therefore not built or chained.
- `market_screener_snapshot` contains only **1,827** symbols and is dated no later than **2026-08-06**. Of the 2,656 eligible symbols, **959 are missing from the snapshot**, **963 have no live row**, and **798 have fewer than 30 settled bars**.
- The frontend merges by mapping only over static rows. A symbol returned by the live candidate query still cannot enter the results when it is absent from the stale static snapshot.
- The exact stored data currently produces 35 matches. ET examples such as Unichem, TCPL Packaging and Finolex Cables were below 5% at the frozen 13:45 capture, while Matrimony, OM Infra and Abans Enterprises are absent from the screener snapshot.
- Penny exclusion itself is currently effective in the published planes: 55 active NSE EQ names are marked penny, while current live and screener rows contain zero marked pennies. The remaining task is to make this exclusion structural so penny names never consume upstream, database, or browser egress.
- Today’s measured waste is concentrated in repeated obsolete reads: 258 sweep-snapshot responses used **15.9 MB**, 30 normal screener responses used **5.05 MB**, and the sweep made 1,106 daily-price reads plus 1,172 stock-reference reads.

## Repair plan

### 1. Restore the deployed full-universe sweep

- Deploy the current `market-live-sweep` and shared snapshot implementation together so runtime uses `market_live_sweep_universe()`, 400-symbol chunks, snapshot versioning and strict universe-count validation.
- Trigger one fresh authenticated sweep and require a 2,656-symbol snapshot across seven chunks, one sweep ID/timestamp, every chunk chained, and successful atomic promotion.
- Treat a missing/invalid snapshot chunk as a failed run with explicit diagnostics; never interpret a 169-row legacy payload as a complete universe.
- Preserve the last good plane until a complete replacement is ready. Do not lower the coverage floor merely to make promotion succeed.

### 2. Make penny exclusion a zero-egress boundary

- Keep one authoritative eligibility predicate: active NSE EQ, mainboard series, and `penny_excluded = false`.
- Apply it before snapshot construction, anchor resolution, broker token preparation, quote requests, staging, promotion, screener snapshot refresh, counts and browser reads.
- Add database-side guards so a newly flagged penny symbol is removed from disposable sweep/live/screener planes immediately and cannot be written back by another producer.
- Make all screener reads originate from an eligible-only server surface rather than fetching rows and discarding penny names in the browser.
- Add an invariant audit reporting penny rows in snapshot, stage, live, screener and response planes; every count must remain zero.
- Preserve settled historical data needed for audit unless already covered by the existing explicit penny purge policy; the optimization target is future processing and transfer, not destructive history removal without evidence.

### 3. Rebuild the complete eligible screener population

- Refresh `market_screener_snapshot` from the current eligible source after the live plane is repaired, replacing the stale 1,827-row snapshot.
- Backfill the nine eligible symbols with no score and bounded batches of eligible symbols missing required static records.
- Keep symbols with fewer than 30 settled bars in the universe but mark `Volume > 30D Avg` as unknown until 30 real sessions exist; do not invent averages.
- Produce named exclusion counts for no quote, no score, insufficient history, invalid anchor, penny, SME and inactive.

### 4. Fix candidate-set and filter correctness

- Build the merged result from the union of static and live keys, then hydrate each key and run the existing client predicate as the final authority. Do not map only over static rows.
- Push Price, 1D return and current Volume only to the live candidate query in Live mode; push settled equivalents only in EOD mode. Never use a six-hour static cache to decide an intraday candidate set.
- Push Market Cap using the same live/EOD basis displayed by the selected mode.
- Use strict `>` semantics for the four requested filters and test boundary values explicitly.
- In Live mode, require one promoted current-session quote for Price, 1D and Volume. Static score dates must not reject a valid live quote.
- Default `Volume > 30D Avg` to the raw full-day basis for ET comparison, while retaining the pace-adjusted mode as an explicit alternative.

### 5. Repair market-data integrity without hiding genuine movers

- Recompute settled anchors and verify suspicious moves using feed previous-close/current-session data rather than rejecting every move beyond a fixed ±21% rule.
- Quarantine confirmed bad anchors with a named reason; retain genuine circuit-limit moves.
- Audit live market cap against reported cap and shares × live price, and audit 30-day average volume from the last 30 settled sessions.
- Correct confirmed source rows such as Cupid’s cap/shares anomaly, then refresh affected scores and the screener snapshot.

### 6. Minimize egress with result-equivalence guarantees

- Build the compact columnar universe/anchor/token snapshot once per session and version; read exactly one 400-symbol JSON chunk per invocation. Never read the whole payload per chunk.
- Reuse the snapshot across five-minute sweeps until the session, eligibility fingerprint, chunk size or schema version changes.
- Remove legacy watched-universe, repeated daily-price anchor, repeated token and whole-snapshot reads after equivalence is confirmed.
- Move the final numeric candidate filtering and pagination to an eligible-only server query/RPC that returns only projected columns and matching rows; request separate lightweight counts/diagnostics rather than the full universe.
- Cache static data by settled-session/version, not only a six-hour wall-clock TTL. Invalidate on snapshot refresh or eligibility-version change.
- Poll the live candidate response only after a newly promoted sweep ID appears; do not refetch identical five-minute data on focus or an independent timer.
- Cache index membership by index version and fetch it only when the selected universe or visible columns require it.
- Keep explicit paged load-all only for export. Normal filtered screens must stay below the 128 KB response ceiling.
- Do not introduce slower tail polling, quote omission or lossy change-only staging unless automated equivalence tests prove identical symbol sets and volume semantics.

## Validation gates

1. Confirm the deployed edge version builds 2,656 eligible symbols in seven chunks and promotes a single fresh full plane; verify every penny count is zero before and after promotion.
2. Compare universe, snapshot, staged-valid and promoted symbol sets. Every difference must have a named reason, not an unexplained count.
3. Run the four filters against an unoptimised eligible full-query control and the optimized server path; assert identical symbols, values and strict-boundary behavior.
4. Verify that a live-only symbol and a symbol crossing 5% after static cache creation enter results without a reload.
5. Capture ET and this screener at the same minute and generate a symbol-level diff with values and exclusion reasons. Do not claim 45-result parity unless the same-time values support it; ET’s count can legitimately move with its capture time.
6. Re-read egress after a full session: no penny-related transfer, no whole-snapshot repetition, no normal screener response above 128 KB, and no result difference from the full-query control.

## Technical scope

- Database: authoritative eligible-universe surface, write guards/invariants, sweep begin/promote alignment, eligible screener refresh and compact server-side candidate query.
- Edge functions: `market-live-sweep`, shared sweep snapshot logic, deployment verification and data validation.
- Frontend: union merge, mode-aware pushdown, cache/version keys, promotion-driven polling, diagnostics and regression tests.
- Disposable sweep/live/screener planes may be rebuilt. No holdings, orders, user data or valid settled history will be deleted.