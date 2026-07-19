CREATE OR REPLACE FUNCTION public.verify_market_cron_secret(_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM vault.decrypted_secrets
    WHERE name IN ('market_cron_secret', 'CRON_SECRET', 'SYNC_HOOK_SECRET', 'MARKET_CRON_SECRET')
      AND decrypted_secret = _secret
  );
$$;

REVOKE ALL ON FUNCTION public.verify_market_cron_secret(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_market_cron_secret(text) TO service_role;

CREATE OR REPLACE FUNCTION public.market_cron_call(fn_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  secret text;
BEGIN
  SELECT decrypted_secret INTO secret
  FROM vault.decrypted_secrets
  WHERE name IN ('market_cron_secret', 'CRON_SECRET', 'SYNC_HOOK_SECRET', 'MARKET_CRON_SECRET')
  ORDER BY CASE name
    WHEN 'market_cron_secret' THEN 1
    WHEN 'CRON_SECRET' THEN 2
    WHEN 'SYNC_HOOK_SECRET' THEN 3
    ELSE 4
  END
  LIMIT 1;

  IF secret IS NULL THEN
    RAISE EXCEPTION 'market cron secret is not configured';
  END IF;

  RETURN net.http_post(
    url := 'https://ybtaxgstmxnlwurkritg.supabase.co/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
END $$;

REVOKE ALL ON FUNCTION public.market_cron_call(text) FROM public, anon, authenticated;