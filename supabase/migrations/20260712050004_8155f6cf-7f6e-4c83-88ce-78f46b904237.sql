ALTER TABLE public.jarvis_usage_daily
  ADD COLUMN IF NOT EXISTS endpoint text NOT NULL DEFAULT 'legacy';

DO $$
DECLARE
  cons_name text;
BEGIN
  SELECT conname INTO cons_name
  FROM pg_constraint
  WHERE conrelid = 'public.jarvis_usage_daily'::regclass
    AND contype = 'u'
    AND (
      SELECT array_agg(attname::text ORDER BY attname::text)
      FROM unnest(conkey) k
      JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k
    ) = ARRAY['day','user_id'];
  IF cons_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.jarvis_usage_daily DROP CONSTRAINT %I', cons_name);
  END IF;
END $$;

DROP INDEX IF EXISTS public.jarvis_usage_daily_user_id_day_key;

CREATE UNIQUE INDEX IF NOT EXISTS jarvis_usage_daily_user_day_endpoint_key
  ON public.jarvis_usage_daily (user_id, day, endpoint);

DROP FUNCTION IF EXISTS public.increment_jarvis_usage(uuid, integer, bigint);

CREATE OR REPLACE FUNCTION public.increment_jarvis_usage(
  _user_id uuid,
  _requests integer DEFAULT 1,
  _tokens bigint DEFAULT 0,
  _endpoint text DEFAULT 'legacy'
)
RETURNS TABLE(requests integer, tokens bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  today date := (now() AT TIME ZONE 'utc')::date;
BEGIN
  INSERT INTO public.jarvis_usage_daily(user_id, day, endpoint, requests, tokens)
  VALUES (_user_id, today, _endpoint, _requests, _tokens)
  ON CONFLICT (user_id, day, endpoint) DO UPDATE
    SET requests = public.jarvis_usage_daily.requests + EXCLUDED.requests,
        tokens   = public.jarvis_usage_daily.tokens   + EXCLUDED.tokens,
        updated_at = now()
  RETURNING public.jarvis_usage_daily.requests, public.jarvis_usage_daily.tokens
  INTO requests, tokens;
  RETURN NEXT;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.increment_jarvis_usage(uuid, integer, bigint, text) TO authenticated, service_role;