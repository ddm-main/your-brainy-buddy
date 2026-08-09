-- The restore left EXECUTE on PUBLIC for several SECURITY DEFINER routines,
-- so anyone holding the publishable key could dispatch cron work or prune
-- history. Lock them to the roles that actually call them.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- record_egress is called from the browser by the signed-in usage meter.
GRANT EXECUTE ON FUNCTION public.record_egress(text, jsonb) TO authenticated;