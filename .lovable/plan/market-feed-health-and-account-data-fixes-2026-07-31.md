# Market feed health and account-data fixes

## Confirmed problems

- The navbar’s `14/16` is calculated as only `LIVE + FALLBACK`; the two intentional `IDLE` feeds are omitted. The shared platform is healthy, so this should read `16/16`.
- Funds, holdings, positions, and order routes are marked per-user and removed from the 16-feed platform tally. Their failures therefore appear in table rows but not in the summary, producing the misleading `0 down`.
- The latest stored Kotak funds probe still says “available margin not reported,” although the current parser source derives a valid zero available balance from Kotak’s all-zero limits payload. The running edge function needs the corrected parser deployed and the probe rerun.
- The Kotak account currently returns a valid zero-balance funds payload, one holding, and zero positions. These are valid results, not outages. The holdings table is stale because a health probe verifies broker access but does not persist an account sync.
- Market depth returns no ladder after the session closes. It should be `IDLE` outside market hours rather than shown as degraded/down.

## Changes

1. **Make the navbar number mean platform availability**
   - Count `LIVE`, `FALLBACK`, and intentional `IDLE` states as healthy.
   - Keep delayed/down/not-configured out of the numerator.
   - Update the tooltip to explicitly say “healthy,” with active, fallback, idle, delayed, and down details.

2. **Separate platform health from account health**
   - Preserve the 16 shared-feed platform denominator so the navbar can correctly show `16/16`.
   - Add a separate account-health tally for funds/margin, holdings, positions, and broker order routes.
   - Split the Feed Routing summary into clearly labelled **Platform feeds** and **Your broker account** groups so a personal failure is never hidden behind `0 down` and never misreported as a platform outage.
   - Surface an account warning in the navbar tooltip/chip state when an account route genuinely fails, without changing the `16/16` platform number.

3. **Correct state classification**
   - Treat session-only depth with an empty closed-market response as `IDLE`.
   - Treat valid empty broker results (`₹0` funds, zero positions, zero holdings) as healthy.
   - Keep `NOT SET` for an unconfigured secondary broker neutral; it must not override the connected active broker’s result.
   - Ensure on-demand account feeds use probe success for connectivity and snapshot age only for a separate freshness message.

4. **Fix funds and account freshness end to end**
   - Deploy the corrected Kotak limits parser and funds self-test together, then rerun the provider self-test so the stale degraded probe is replaced.
   - After a successful manual account test/refresh, invalidate funds, holdings, positions, freshness, and probe queries together.
   - Make account refresh actions persist the returned holdings/positions/funds snapshots; a connectivity-only self-test will remain non-mutating and be labelled accordingly.

5. **Regression checks**
   - Add unit coverage for healthy-idle tallying, separate platform/account tallies, closed-session depth, valid zero balances, empty holdings/positions, fallback routing, and unconfigured secondary brokers.
   - Verify the live preview after a fresh self-test: platform shows `16/16`; account health separately reports the real broker state; funds shows `₹0` rather than down; holdings shows one synced holding; closed-session depth shows idle.

## Technical notes

- Keep `useFeedStatus` as the single status engine; expose both `platformTally` and `accountTally` from it rather than recomputing counts in components.
- Feed Routing and `FeedStatusChip` will consume those same two tallies.
- No credentials will be stored or added to code. The authenticated preview session will be used for verification.