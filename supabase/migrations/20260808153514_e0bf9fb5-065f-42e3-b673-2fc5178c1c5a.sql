-- 1. market_api_settings.purpose
ALTER TABLE public.market_api_settings
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'account';

DO $$ BEGIN
  ALTER TABLE public.market_api_settings
    ADD CONSTRAINT market_api_settings_purpose_chk CHECK (purpose IN ('account','data'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE public.market_api_settings SET purpose = 'data' WHERE is_system IS TRUE;

-- is_system may only be true on a data-purpose row
CREATE OR REPLACE FUNCTION public.guard_market_api_settings_purpose()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.is_system IS TRUE AND NEW.purpose <> 'data' THEN
    RAISE EXCEPTION 'only a data-purpose connection can be the system feed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_market_api_settings_purpose_trg ON public.market_api_settings;
CREATE TRIGGER guard_market_api_settings_purpose_trg
BEFORE INSERT OR UPDATE ON public.market_api_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_market_api_settings_purpose();

-- 2. market_feed_prefs → app-wide scope
ALTER TABLE public.market_feed_prefs
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'system';

DO $$ BEGIN
  ALTER TABLE public.market_feed_prefs
    ADD CONSTRAINT market_feed_prefs_scope_chk CHECK (scope IN ('system','user'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.market_feed_prefs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.market_feed_prefs ALTER COLUMN user_id DROP DEFAULT;

-- Keep admin rows as the app-wide settings; drop everyone else's copies.
DELETE FROM public.market_feed_prefs p
WHERE NOT public.has_role(p.user_id, 'admin');

-- Collapse to one row per feed_id (newest wins).
DELETE FROM public.market_feed_prefs p
USING public.market_feed_prefs q
WHERE p.feed_id = q.feed_id
  AND p.ctid < q.ctid;

UPDATE public.market_feed_prefs SET scope = 'system', user_id = NULL;

CREATE UNIQUE INDEX IF NOT EXISTS market_feed_prefs_system_feed_uidx
  ON public.market_feed_prefs (feed_id) WHERE scope = 'system';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_feed_prefs TO authenticated;
GRANT ALL ON public.market_feed_prefs TO service_role;

DROP POLICY IF EXISTS "Users manage their feed prefs" ON public.market_feed_prefs;
DROP POLICY IF EXISTS "feed prefs own rows" ON public.market_feed_prefs;
DROP POLICY IF EXISTS "market_feed_prefs_own" ON public.market_feed_prefs;

CREATE POLICY "Authenticated can read system feed prefs"
ON public.market_feed_prefs FOR SELECT TO authenticated
USING (scope = 'system');

CREATE POLICY "Admins manage system feed prefs"
ON public.market_feed_prefs FOR ALL TO authenticated
USING (scope = 'system' AND public.has_role(auth.uid(), 'admin'))
WITH CHECK (scope = 'system' AND public.has_role(auth.uid(), 'admin'));