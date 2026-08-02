DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('market-score-backfill-drain', '*/15 3-14 * * 1-5'),
      ('market-selftest-fast',        '*/30 3-10 * * 1-5'),
      ('market-selftest-hourly',      '5 */6 * * *'),
      ('market-history-backfill',     '0 18-23 * * *'),
      ('market-news-sync',            '0 3,7,11 * * 1-5')
    ) AS t(name, sched)
  LOOP
    PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = r.name), schedule => r.sched);
  END LOOP;
END $$;