-- =========================================================================
-- market-pipeline-eod couldn't cover the universe in a day even with zero
-- failures: '*/5 13-14 * * 1-5' is a 2-hour window = 24 ticks/day, and at
-- CHUNK=100 symbols/tick that's a 2,400/day ceiling against a ~2,699-stock
-- universe. Because the sync cursor is stamped once per day even on
-- failure (so one bad symbol can't wedge the pipeline), the ~300 symbols
-- that miss out rotate to a different subset each day rather than being
-- retried later the same day — meaning on any given day roughly 11% of the
-- universe is showing yesterday's-or-older data, indistinguishable from
-- fresh data to any single-symbol staleness check since it's not an
-- outlier relative to the rest of a partially-stale dataset.
--
-- market-pipeline-aggregates ran at a fixed 30 14 * * 1-5 (14:30 UTC) —
-- before the EOD window itself even finished (14:59 UTC) — so the daily
-- rescore always ran against a partial sync regardless of the fix below.
--
-- Widening the window + increasing tick frequency (not CHUNK size, which
-- risks a single tick not finishing inside its slot) gives real headroom:
-- 3-hour window, 4-min ticks = 45 ticks x 100 = 4,500/day capacity.
-- Aggregates moves to after the widened window closes, with a buffer.
-- =========================================================================

SELECT cron.unschedule('market-pipeline-eod') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-pipeline-eod');
SELECT cron.schedule('market-pipeline-eod', '*/4 12-14 * * 1-5',
  $$SELECT public.market_cron_call('market-pipeline-eod')$$);

SELECT cron.unschedule('market-pipeline-aggregates') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-pipeline-aggregates');
SELECT cron.schedule('market-pipeline-aggregates', '15 15 * * 1-5',
  $$SELECT public.market_cron_call('market-pipeline-aggregates')$$);
