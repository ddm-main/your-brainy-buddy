
-- Phase 1 finish: block new signups, schedule interaction retention purge.

-- 1) Block new auth.users inserts (except the sole existing account by uid).
CREATE OR REPLACE FUNCTION public.block_new_signups()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.id <> '2ff4497a-dedc-4885-98e5-435b26894275'::uuid THEN
    RAISE EXCEPTION 'signups are disabled';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS block_new_signups ON auth.users;
CREATE TRIGGER block_new_signups
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.block_new_signups();

-- 2) Schedule the existing purge_old_jarvis_interactions() weekly.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge_jarvis_interactions_weekly') THEN
    PERFORM cron.unschedule('purge_jarvis_interactions_weekly');
  END IF;
END $$;

SELECT cron.schedule(
  'purge_jarvis_interactions_weekly',
  '0 3 * * 0',
  $$SELECT public.purge_old_jarvis_interactions();$$
);
