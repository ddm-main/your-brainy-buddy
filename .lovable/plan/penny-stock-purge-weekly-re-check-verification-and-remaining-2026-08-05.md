# Penny-stock purge + weekly re-check — verification and remaining gaps

## Verified current state (checked against the live database)

- Penny rule is live as an OR rule in `market_penny_sweep(_min_cap_cr, _min_price)`: market cap < 1,000 Cr (rows with no cap on record are not judged on cap) OR last settled close < 50.
- 1,209 symbols are flagged `penny_excluded` and dropped out of the universe; 1,628 active symbols remain clean, with 0 active cap violations.
- Zero penny rows remain in daily prices, scores, or the screener snapshot.
- Weekly re-check is scheduled: `market-penny-sweep-weekly` runs Saturdays 04:15 UTC.
- New penny rows are blocked at write time by the `block_penny_rows` / `enforce_penny_exclusion` triggers.
- History ceiling is 2 years: oldest daily bar is 2024-08-05, with `jarvis-monthly-history-ceiling` and `market-archive-prune-monthly` on the 1st of each month, followed by monthly `jarvis-monthly-vacuum-*` compaction jobs.
- Database is at 157 MB (down from 406 MB) after compaction.

## Remaining gaps to close

1. **Inactive symbols escape the sweep.** `market_penny_sweep` only evaluates `is_active = true`, so the 355 inactive symbols carry stale `penny_excluded = false`. If any is ever reactivated it enters the universe unjudged. Fix: evaluate all symbols regardless of `is_active`, keeping reinstatement limited to active ones.

2. **Reinstatement can use a stale price.** The sweep joins only the single latest `trade_date`; a symbol with no bar on that date is treated as "no price" and can be reinstated on cap alone. Fix: use the latest close within the last 10 sessions per symbol instead of the exact max date.

3. **One-off compaction jobs still scheduled.** `vacuum-oneshot-*` jobs remain in cron with an Aug-5 date pattern. Fix: unschedule them so they don't rerun next year.

4. **Sweep observability.** Add a lightweight check in the maintenance log so a failed weekly sweep is visible rather than silent.

## Technical notes

- All changes are database-side: one migration replacing `market_penny_sweep` with the widened evaluation and 10-session price lookback, plus a data operation to unschedule the leftover one-off vacuum jobs.
- No frontend changes required; the screener already reads the penny-filtered snapshot.
- After the migration, run one manual sweep to re-stamp the 355 inactive symbols.
