ALTER TABLE public.system_quota_state
  ADD COLUMN IF NOT EXISTS db_reported_bytes bigint;

CREATE OR REPLACE FUNCTION public.quota_report()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  cycle_day smallint;
  win_start date;
BEGIN
  IF auth.uid() IS NULL THEN
    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  ELSIF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can read quota reports';
  END IF;

  SELECT COALESCE(egress_cycle_day, 23) INTO cycle_day FROM public.system_quota_state LIMIT 1;
  IF cycle_day IS NULL THEN cycle_day := 23; END IF;
  win_start := CASE
    WHEN EXTRACT(DAY FROM current_date) >= cycle_day
      THEN make_date(EXTRACT(YEAR FROM current_date)::int, EXTRACT(MONTH FROM current_date)::int, cycle_day)
    ELSE (make_date(EXTRACT(YEAR FROM current_date)::int, EXTRACT(MONTH FROM current_date)::int, cycle_day) - interval '1 month')::date
  END;

  RETURN (
    SELECT jsonb_build_object(
      -- Supabase bills the whole instance, not just this database, so the
      -- panel tracks the sum of every database on it.
      'db_bytes', (SELECT COALESCE(sum(pg_database_size(d.datname)), 0) FROM pg_database d),
      'db_own_bytes', pg_database_size(current_database()),
      'db_reported_bytes', (SELECT q.db_reported_bytes FROM public.system_quota_state q LIMIT 1),
      'db_limit_bytes', (500::bigint * 1024 * 1024),
      'storage_bytes', COALESCE((SELECT SUM((o.metadata->>'size')::bigint) FROM storage.objects o), 0),
      'storage_limit_bytes', (1024::bigint * 1024 * 1024),
      'mau', (SELECT count(*) FROM auth.users u WHERE u.last_sign_in_at >= win_start),
      'mau_limit', 50000,
      'cycle_start', win_start,
      'egress_bytes', COALESCE((SELECT q.egress_bytes FROM public.system_quota_state q LIMIT 1), 0),
      'egress_reported_bytes', (SELECT q.egress_reported_bytes FROM public.system_quota_state q LIMIT 1),
      'egress_budget_bytes', COALESCE((SELECT q.egress_budget_bytes FROM public.system_quota_state q LIMIT 1), (4::bigint * 1024 * 1024 * 1024)),
      'egress_limit_bytes', COALESCE((SELECT q.egress_limit_bytes FROM public.system_quota_state q LIMIT 1), (5::bigint * 1024 * 1024 * 1024)),
      'egress_sources', COALESCE((
        SELECT jsonb_agg(e) FROM (
          SELECT source, route, sum(bytes) AS bytes, sum(requests) AS requests
          FROM public.system_egress_daily WHERE day >= win_start
          GROUP BY source, route ORDER BY sum(bytes) DESC LIMIT 15
        ) e
      ), '[]'::jsonb),
      'buckets', COALESCE((
        SELECT jsonb_agg(b) FROM (
          SELECT o.bucket_id AS name, COUNT(*) AS objects,
                 COALESCE(SUM((o.metadata->>'size')::bigint), 0) AS bytes
          FROM storage.objects o GROUP BY o.bucket_id
        ) b
      ), '[]'::jsonb),
      'quota', COALESCE((SELECT to_jsonb(q) FROM public.system_quota_state q LIMIT 1), '{}'::jsonb)
    )
  );
END;
$function$;