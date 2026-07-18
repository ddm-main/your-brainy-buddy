-- market autosync — schedule the jobs the market_v2 migration left manual.
-- Reuses public.market_cron_call(fn) (Vault secret → edge fn with x-cron-secret).
-- Idempotent: unschedule first so re-applying doesn't error on duplicate names.

SELECT cron.unschedule('market-fundamentals-global-sync') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-fundamentals-global-sync');
SELECT cron.unschedule('market-fii-dii-sync') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-fii-dii-sync');

-- Fundamentals: chunked (40/call) + self-draining. Every 15 min fills ~508 stocks
-- in ~13 ticks, then no-ops until rows go stale (>7 days) and auto-refill.
SELECT cron.schedule('market-fundamentals-global-sync', '*/15 * * * *',
  $$SELECT public.market_cron_call('market-fundamentals-global-sync')$$);

-- FII/DII: once after the NSE close on weekdays (12:00 UTC ≈ 17:30 IST).
SELECT cron.schedule('market-fii-dii-sync', '0 12 * * 1-5',
  $$SELECT public.market_cron_call('market-fii-dii-sync')$$);
