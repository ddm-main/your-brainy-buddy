# Egress pass 2 — kill the four remaining offenders

Measured today (`system_egress_daily`, 2026-08-10), largest first:

| Route | Requests | Bytes |
|---|---|---|
| `market-pipeline-aggregates market_stock_scores (76c) !OVER` | 11 | 20.6 MB |
| `srv:market_stocks` (no caller label, last write 06:00) | 2,318 | 14.0 MB |
| `market-live-sweep market_stocks (5c)` (still live at 10:46) | 922 | 8.7 MB |
| `market_api_settings` across quotes/sweep/orders/indices/autotrade | ~2,000 | ~7.5 MB |
| `market-live-sweep rpc/market_live_settled_anchors_lean` (live at 10:46) | 240 | 4.0 MB |
| `market-live-sweep market_daily_prices (5c)` | 910 | 1.3 MB |

The `(1c)` and `(4c)` sweep rows stopped at 10:05 — those are the pre-deploy runs the snapshot removed. The `(5c)`, `market_daily_prices` and anchors rows are still being written after the deploy, so a second code path in the sweep is bypassing the snapshot.

## 1. Finish the sweep snapshot (≈14 MB/day)

`market-live-sweep/index.ts` no longer reads `market_stocks` directly, so the remaining `(5c)` reads, the anchors RPC and the `market_daily_prices` page come from a shared helper the sweep calls per chunk (prev-close/settlement fallback and index quotes). Trace the actual caller, then serve those values from the snapshot payload that is already built once per sweep — extend the snapshot with the prev-close/settlement map instead of re-resolving per chunk. Verify by triggering one sweep and confirming the only sweep routes left for that minute are the single `market_universe` read plus the per-chunk snapshot slice.

## 2. Slim the settings read (≈6 MB/day)

Every function re-reads the whole 23-column `market_api_settings` row (~3.9 KB) on each cold isolate. Add a security-definer RPC that returns only the fields needed for the row's `active_provider` (session token, expiry, credentials for that broker) as a single small object, and route `getSettingsRows` / `getSystemFeedRow` through it. Keeps the existing 10-minute isolate cache; cuts each cold-start read from ~3.9 KB to a few hundred bytes.

## 3. Attribute and fix the 14 MB unlabelled `market_stocks` block

2,318 requests with no caller prefix means those functions never call `setEgressCaller`. Move the call into the shared preflight/service-client factory so labelling is automatic and no function can opt out, then re-check the next morning sync window (the block lands around 06:00, i.e. the scrip/master/fundamentals sync chain) and apply the same narrow-projection + `market_universe` treatment to whichever function owns it.

## 4. Move aggregate math into SQL (≈20 MB/day)

`market-pipeline-aggregates` still downloads 76 columns of `market_stock_scores` in 11 paged requests. Replace the download with a security-definer RPC that computes the distribution/percentile aggregates server-side and returns only the summary rows, keeping the row-level download only for the v4 rescoring path — and narrow that path to the columns the rescorer actually reads.

## 5. Guardrail

Make `apply_egress_governor()` (or the daily maintenance job) log the top three `!OVER` routes of the day so a regression names itself instead of waiting for a manual audit.

## Technical notes

- New RPCs are `security definer`, `stable`, `set search_path = public`, granted to `service_role` only.
- Snapshot changes stay inside `_shared/market/sweepSnapshot.ts`; payload shape stays keyed per chunk index.
- Each step is verified against `system_egress_daily` after deploy before moving to the next — no step is called done on code inspection alone.
