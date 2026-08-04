CREATE TABLE IF NOT EXISTS public.system_egress_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  source text NOT NULL,
  route text NOT NULL DEFAULT '',
  bytes bigint NOT NULL DEFAULT 0,
  requests integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day, source, route)
);

GRANT SELECT ON public.system_egress_daily TO authenticated;
GRANT ALL ON public.system_egress_daily TO service_role;

ALTER TABLE public.system_egress_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins read egress daily" ON public.system_egress_daily;
CREATE POLICY "admins read egress daily" ON public.system_egress_daily
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS system_egress_daily_day_idx ON public.system_egress_daily (day DESC);

ALTER TABLE public.system_quota_state
  ADD COLUMN IF NOT EXISTS egress_cycle_day smallint NOT NULL DEFAULT 23,
  ADD COLUMN IF NOT EXISTS egress_reported_bytes bigint,
  ADD COLUMN IF NOT EXISTS egress_reported_at timestamptz;

-- Any authenticated client can report the bytes it received; the function
-- clamps the shape so a caller cannot write arbitrary rows.
CREATE OR REPLACE FUNCTION public.record_egress(_source text, _rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  n integer := 0;
  src text := lower(COALESCE(_source, 'unknown'));
BEGIN
  IF auth.uid() IS NULL AND current_user NOT IN ('service_role','postgres','supabase_admin') THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF src NOT IN ('postgrest','functions','storage','realtime','auth','unknown') THEN
    src := 'unknown';
  END IF;

  INSERT INTO public.system_egress_daily (day, source, route, bytes, requests)
  SELECT (now() AT TIME ZONE 'utc')::date,
         src,
         left(COALESCE(r->>'route', ''), 120),
         GREATEST(0, LEAST(COALESCE((r->>'bytes')::bigint, 0), 5000000000)),
         GREATEST(0, LEAST(COALESCE((r->>'requests')::integer, 0), 1000000))
  FROM jsonb_array_elements(COALESCE(_rows, '[]'::jsonb)) AS r
  WHERE COALESCE((r->>'bytes')::bigint, 0) > 0
  ON CONFLICT (day, source, route) DO UPDATE
    SET bytes = public.system_egress_daily.bytes + EXCLUDED.bytes,
        requests = public.system_egress_daily.requests + EXCLUDED.requests,
        updated_at = now();

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_egress(text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.record_egress(text, jsonb) TO authenticated, service_role;

-- Roll the measured daily rows into the cycle total on system_quota_state.
CREATE OR REPLACE FUNCTION public.egress_cycle_rollup()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  cycle_day smallint;
  win_start date;
  win_end date;
  total bigint;
  split jsonb;
BEGIN
  SELECT COALESCE(egress_cycle_day, 23) INTO cycle_day FROM public.system_quota_state LIMIT 1;
  IF cycle_day IS NULL THEN cycle_day := 23; END IF;

  win_start := CASE
    WHEN EXTRACT(DAY FROM current_date) >= cycle_day
      THEN make_date(EXTRACT(YEAR FROM current_date)::int, EXTRACT(MONTH FROM current_date)::int, cycle_day)
    ELSE (make_date(EXTRACT(YEAR FROM current_date)::int, EXTRACT(MONTH FROM current_date)::int, cycle_day) - interval '1 month')::date
  END;
  win_end := (win_start + interval '1 month')::date;

  SELECT COALESCE(sum(bytes), 0) INTO total
    FROM public.system_egress_daily WHERE day >= win_start AND day < win_end;

  SELECT COALESCE(jsonb_object_agg(source, b), '{}'::jsonb) INTO split FROM (
    SELECT source, sum(bytes) AS b FROM public.system_egress_daily
    WHERE day >= win_start AND day < win_end GROUP BY source
  ) s;

  UPDATE public.system_quota_state SET
    egress_bytes = total,
    egress_breakdown = split,
    egress_window_start = win_start,
    egress_window_end = win_end,
    egress_synced_at = now(),
    updated_at = now();

  -- 90 days of daily rows is plenty of history for three cycles.
  DELETE FROM public.system_egress_daily WHERE day < current_date - 90;

  RETURN jsonb_build_object('ok', true, 'egress_bytes', total, 'breakdown', split,
                            'window_start', win_start, 'window_end', win_end);
END;
$function$;

REVOKE ALL ON FUNCTION public.egress_cycle_rollup() FROM public;
GRANT EXECUTE ON FUNCTION public.egress_cycle_rollup() TO authenticated, service_role;

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
      'db_bytes', pg_database_size(current_database()),
      'db_limit_bytes', (500::bigint * 1024 * 1024),
      -- Supabase bills disk, which is the database plus WAL and the internal
      -- databases; pg_database_size alone reads ~8% low against the billing card.
      'disk_bytes', pg_database_size(current_database())
                    + COALESCE((SELECT sum((pg_stat_file('pg_wal/' || name)).size)
                                  FROM pg_ls_waldir() AS w(name, size, modification)), 0),
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