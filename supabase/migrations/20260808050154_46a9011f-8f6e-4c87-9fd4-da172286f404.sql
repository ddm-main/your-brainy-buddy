CREATE OR REPLACE FUNCTION public.market_cron_call(fn_name text)
 RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE secret text;
BEGIN
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets
  WHERE name IN ('market_cron_secret','CRON_SECRET','SYNC_HOOK_SECRET','MARKET_CRON_SECRET')
  ORDER BY CASE name WHEN 'market_cron_secret' THEN 1 WHEN 'CRON_SECRET' THEN 2 WHEN 'SYNC_HOOK_SECRET' THEN 3 ELSE 4 END
  LIMIT 1;
  IF secret IS NULL THEN RAISE EXCEPTION 'market cron secret is not configured'; END IF;
  RETURN net.http_post(
    url := 'https://olwxfgrnbxkpoeofyfcm.supabase.co/functions/v1/' || fn_name,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', secret),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
END $function$;

CREATE OR REPLACE FUNCTION public.market_cron_call_body(fn_name text, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE secret text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can invoke market cron functions';
  END IF;
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets
  WHERE name IN ('market_cron_secret','CRON_SECRET','SYNC_HOOK_SECRET','MARKET_CRON_SECRET')
  ORDER BY CASE name WHEN 'market_cron_secret' THEN 1 WHEN 'CRON_SECRET' THEN 2 WHEN 'SYNC_HOOK_SECRET' THEN 3 ELSE 4 END
  LIMIT 1;
  IF secret IS NULL THEN RAISE EXCEPTION 'market cron secret is not configured'; END IF;
  RETURN net.http_post(
    url := 'https://olwxfgrnbxkpoeofyfcm.supabase.co/functions/v1/' || fn_name,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', secret),
    body := COALESCE(payload,'{}'::jsonb), timeout_milliseconds := 150000);
END $function$;

REVOKE EXECUTE ON FUNCTION public.market_cron_call(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.market_cron_call_body(text, jsonb) FROM PUBLIC, anon;