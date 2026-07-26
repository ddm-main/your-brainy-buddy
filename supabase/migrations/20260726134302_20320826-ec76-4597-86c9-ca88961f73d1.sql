SELECT cron.schedule(
  'market-history-backfill',
  '*/3 * * * *',
  $$SELECT public.market_cron_call('market-history-backfill')$$
);