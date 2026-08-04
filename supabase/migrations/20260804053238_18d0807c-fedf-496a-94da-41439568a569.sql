-- 1. Cron cadence: match job frequency to how often the data changes.
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'market-score-backfill-drain'), schedule := '10 19,22 * * 1-5');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'market-screener-snapshot-refresh'), schedule := '0 4-11 * * 1-5');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'market-rescore-snapshot-retry'), schedule := '20 14,16,18 * * 1-5');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'market-selftest-fast'), schedule := '15 3-10 * * 1-5');
SELECT cron.unschedule('market-selftest-hourly');

-- 2. Egress tracking on the single quota state row.
ALTER TABLE public.system_quota_state
  ADD COLUMN IF NOT EXISTS egress_window_start date,
  ADD COLUMN IF NOT EXISTS egress_window_end date,
  ADD COLUMN IF NOT EXISTS egress_limit_bytes bigint NOT NULL DEFAULT (5::bigint * 1024 * 1024 * 1024),
  ADD COLUMN IF NOT EXISTS egress_budget_bytes bigint NOT NULL DEFAULT (4::bigint * 1024 * 1024 * 1024),
  ADD COLUMN IF NOT EXISTS egress_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS egress_synced_at timestamptz;

-- 3. quota_report(): surface the egress figure and the self-imposed budget.
CREATE OR REPLACE FUNCTION public.quota_report()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  ELSIF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can read quota reports';
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'db_bytes', pg_database_size(current_database()),
      'db_limit_bytes', (500::bigint * 1024 * 1024),
      'storage_bytes', COALESCE((SELECT SUM((o.metadata->>'size')::bigint) FROM storage.objects o), 0),
      'storage_limit_bytes', (1024::bigint * 1024 * 1024),
      'egress_bytes', COALESCE((SELECT q.egress_bytes FROM public.system_quota_state q LIMIT 1), 0),
      'egress_budget_bytes', COALESCE((SELECT q.egress_budget_bytes FROM public.system_quota_state q LIMIT 1), (4::bigint * 1024 * 1024 * 1024)),
      'egress_limit_bytes', COALESCE((SELECT q.egress_limit_bytes FROM public.system_quota_state q LIMIT 1), (5::bigint * 1024 * 1024 * 1024)),
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

-- 4. Egress governor: called by the usage sync after it writes a fresh figure.
--    Over 80% of the 4 GB budget the non-essential syncs stand down (they
--    already short-circuit on low_bandwidth).
CREATE OR REPLACE FUNCTION public.apply_egress_governor()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_used bigint;
  v_budget bigint;
  v_pct numeric;
  v_brake boolean;
BEGIN
  SELECT egress_bytes, GREATEST(egress_budget_bytes, 1)
    INTO v_used, v_budget
  FROM public.system_quota_state LIMIT 1;
  IF v_used IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'note', 'no quota row');
  END IF;
  v_pct := ROUND((v_used::numeric / v_budget::numeric) * 100, 1);
  v_brake := v_pct >= 80;
  IF v_brake THEN
    UPDATE public.system_quota_state
       SET low_bandwidth = true, updated_at = now();
  END IF;
  RETURN jsonb_build_object('ok', true, 'egress_pct_of_budget', v_pct, 'low_bandwidth', v_brake);
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_egress_governor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_egress_governor() TO service_role;

-- 5. Twice-daily usage sync (Management API is the only source of egress).
SELECT cron.schedule('supabase-usage-sync', '5 2,14 * * *', $$SELECT public.market_cron_call('supabase-usage-sync')$$);