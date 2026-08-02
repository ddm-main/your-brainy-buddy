DO $$
BEGIN
  PERFORM cron.unschedule('market-screener-snapshot-intraday');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('market-daily-sync-0900-ist');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'market-archive-prices-drain'),
  schedule := '7 * * * *'
);