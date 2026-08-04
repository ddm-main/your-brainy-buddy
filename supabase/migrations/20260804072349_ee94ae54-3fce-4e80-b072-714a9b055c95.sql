DO $$
BEGIN
  PERFORM cron.unschedule('usage-egress-sync');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;