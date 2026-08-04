CREATE OR REPLACE FUNCTION public.set_quota_reported(_egress_bytes bigint DEFAULT NULL, _db_bytes bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  ELSIF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can set reported quota figures';
  END IF;

  UPDATE public.system_quota_state
     SET egress_reported_bytes = COALESCE(GREATEST(_egress_bytes, 0), egress_reported_bytes),
         egress_reported_at    = CASE WHEN _egress_bytes IS NOT NULL THEN now() ELSE egress_reported_at END,
         db_reported_bytes     = COALESCE(GREATEST(_db_bytes, 0), db_reported_bytes),
         updated_at            = now()
   WHERE id = true
  RETURNING jsonb_build_object(
    'egress_reported_bytes', egress_reported_bytes,
    'egress_reported_at', egress_reported_at,
    'db_reported_bytes', db_reported_bytes
  ) INTO res;

  RETURN COALESCE(res, '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.set_quota_reported(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_quota_reported(bigint, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_quota_reported(bigint, bigint) TO service_role;