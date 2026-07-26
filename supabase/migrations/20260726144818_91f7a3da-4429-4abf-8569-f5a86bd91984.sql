ALTER TABLE public.market_api_settings
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS market_api_settings_one_system_idx
  ON public.market_api_settings ((true)) WHERE is_system;

-- Seed: designate the most recently updated connected Kotak row as the system feed.
UPDATE public.market_api_settings s
   SET is_system = true
 WHERE s.id = (
   SELECT id FROM public.market_api_settings
    WHERE active_provider = 'kotak_neo' AND connection_status = 'connected'
    ORDER BY updated_at DESC LIMIT 1
 )
 AND NOT EXISTS (SELECT 1 FROM public.market_api_settings WHERE is_system);

-- Only admins may flip the system designation.
CREATE OR REPLACE FUNCTION public.guard_market_api_settings_is_system()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_system AND auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
      RAISE EXCEPTION 'only admins can designate the system market feed';
    END IF;
  ELSIF NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
      RAISE EXCEPTION 'only admins can designate the system market feed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS market_api_settings_is_system_guard ON public.market_api_settings;
CREATE TRIGGER market_api_settings_is_system_guard
  BEFORE INSERT OR UPDATE ON public.market_api_settings
  FOR EACH ROW EXECUTE FUNCTION public.guard_market_api_settings_is_system();

-- Admin-facing, token-free view of which connection is the system feed.
CREATE OR REPLACE VIEW public.market_system_feed
WITH (security_invoker = false) AS
  SELECT id, user_id, active_provider, connection_status, ucc, greeting_name,
         last_sync_at, last_error, token_expires_at, updated_at
    FROM public.market_api_settings
   WHERE is_system;

GRANT SELECT ON public.market_system_feed TO authenticated;
GRANT ALL ON public.market_system_feed TO service_role;