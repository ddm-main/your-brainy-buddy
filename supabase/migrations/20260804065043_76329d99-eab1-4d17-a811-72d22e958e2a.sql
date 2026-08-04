DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'supabase-usage-sync') THEN
    PERFORM cron.unschedule('supabase-usage-sync');
  END IF;
END $$;

SELECT cron.schedule('usage-egress-sync', '5 2,14 * * *', $$SELECT public.market_cron_call('usage-egress-sync')$$);