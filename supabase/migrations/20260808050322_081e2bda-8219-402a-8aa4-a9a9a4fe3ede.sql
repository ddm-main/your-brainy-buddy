DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f.sig);
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION public.market_cron_call(text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_market_api_settings_is_system() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_default_role_and_access() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.block_new_signups() FROM authenticated;