REVOKE ALL ON FUNCTION public.prune_old_data(boolean) FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.prune_batched(text) FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.db_size_report() FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.score_history_coverage(text) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_old_data(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_batched(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.db_size_report() TO service_role;
GRANT EXECUTE ON FUNCTION public.score_history_coverage(text) TO service_role;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
  END LOOP;
END $$;

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
      'egress_limit_bytes', (5::bigint * 1024 * 1024 * 1024),
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

CREATE OR REPLACE FUNCTION public.archive_coverage()
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
    RAISE EXCEPTION 'only admins can read archive coverage';
  END IF;
  RETURN (
    WITH cfg AS (
      SELECT
        COALESCE(MAX(days) FILTER (WHERE key = 'prices_hot_tracked'), 500) AS hot_tracked,
        COALESCE(MAX(days) FILTER (WHERE key = 'prices_hot_other'), 260)   AS hot_other
      FROM public.system_retention_config
    ), tracked AS (
      SELECT DISTINCT s FROM (
        SELECT symbol s FROM public.market_watchlist_items
        UNION SELECT symbol FROM public.market_holdings
        UNION SELECT symbol FROM public.market_positions
        UNION SELECT symbol FROM public.market_index_members
      ) x
    ), pending AS (
      SELECT count(*) AS n FROM public.market_stocks st
      CROSS JOIN cfg
      LEFT JOIN tracked t ON t.s = st.symbol
      WHERE st.is_active AND st.exchange = 'NSE'
        AND EXISTS (
          SELECT 1 FROM public.market_daily_prices p
          WHERE p.symbol = st.symbol AND p.exchange = st.exchange
            AND p.trade_date < (current_date - CASE WHEN t.s IS NOT NULL
                                                    THEN GREATEST(180, cfg.hot_tracked)
                                                    ELSE GREATEST(120, cfg.hot_other) END)::date
        )
    )
    SELECT jsonb_build_object(
      'archived', (SELECT count(*) FROM public.market_archive_index),
      'universe', (SELECT count(*) FROM public.market_stocks WHERE is_active AND exchange = 'NSE'),
      'archived_bars', (SELECT COALESCE(sum(bars), 0) FROM public.market_archive_index),
      'archived_bytes', (SELECT COALESCE(sum(bytes), 0) FROM public.market_archive_index),
      'pending', (SELECT n FROM pending),
      'last_maintenance', (
        SELECT to_jsonb(l) FROM (
          SELECT ran_at, mode, total_deleted, size_bytes, duration_ms
          FROM public.system_maintenance_log ORDER BY ran_at DESC LIMIT 1
        ) l
      )
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.run_daily_maintenance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  first jsonb;
  second jsonb := NULL;
  v_db_bytes bigint;
  v_store_bytes bigint;
  v_level text := 'ok';
  amber bigint := 380 * 1024 * 1024;
  red   bigint := 430 * 1024 * 1024;
BEGIN
  IF auth.uid() IS NULL THEN
    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  ELSIF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can run maintenance';
  END IF;

  first := public.prune_old_data(false);
  v_db_bytes := (first ->> 'size_bytes')::bigint;

  IF v_db_bytes > amber THEN
    v_level := 'warn';
    second := public.prune_old_data(true);
    v_db_bytes := (second ->> 'size_bytes')::bigint;
  END IF;

  IF v_db_bytes > red THEN
    v_level := 'critical';
    DELETE FROM public.market_indicators_cache;
    DELETE FROM public.market_provider_health WHERE created_at < now() - interval '1 day';
    DELETE FROM public.market_provider_observations WHERE created_at < now() - interval '1 day';
    DELETE FROM public.market_value_audit WHERE checked_at < now() - interval '1 day';
    UPDATE public.system_retention_config
       SET days = GREATEST(180, days - 60), updated_at = now()
     WHERE key = 'prices_hot_tracked';
    UPDATE public.system_retention_config
       SET days = GREATEST(120, days - 60), updated_at = now()
     WHERE key = 'prices_hot_other';
    v_db_bytes := pg_database_size(current_database());
  END IF;

  SELECT COALESCE(SUM((o.metadata->>'size')::bigint), 0) INTO v_store_bytes FROM storage.objects o;

  UPDATE public.system_quota_state
     SET db_bytes = v_db_bytes,
         storage_bytes = v_store_bytes,
         last_level = v_level,
         low_bandwidth = (v_level = 'critical'),
         checked_at = now(),
         updated_at = now()
   WHERE id;

  RETURN jsonb_build_object('level', v_level, 'db_bytes', v_db_bytes,
                            'storage_bytes', v_store_bytes,
                            'normal', first, 'aggressive', second);
END;
$function$;

CREATE OR REPLACE FUNCTION public.market_feed_freshness()
RETURNS TABLE(table_name text, column_name text, last_at timestamp with time zone)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  targets text[][] := ARRAY[
    ARRAY['market_quotes','fetched_at'],
    ARRAY['market_daily_prices','created_at'],
    ARRAY['market_intraday_prices','fetched_at'],
    ARRAY['market_eod_nse','fetched_at'],
    ARRAY['market_funds','synced_at'],
    ARRAY['market_holdings','updated_at'],
    ARRAY['market_positions','updated_at'],
    ARRAY['market_fundamentals_global','updated_at'],
    ARRAY['market_shares_outstanding','updated_at'],
    ARRAY['market_indicators_cache','computed_at'],
    ARRAY['market_index_members','updated_at'],
    ARRAY['corporate_actions','updated_at'],
    ARRAY['market_news','created_at']
  ];
  i integer;
  t text;
  c text;
  v timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
      RETURN;
    END IF;
  ELSIF NOT public.has_role(auth.uid(), 'admin') THEN
    RETURN;
  END IF;
  FOR i IN 1 .. array_length(targets, 1) LOOP
    t := targets[i][1];
    c := targets[i][2];
    BEGIN
      EXECUTE format('SELECT max(%I) FROM public.%I', c, t) INTO v;
    EXCEPTION WHEN OTHERS THEN
      v := NULL;
    END;
    table_name := t;
    column_name := c;
    last_at := v;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.quota_report() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.archive_coverage() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.run_daily_maintenance() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.market_feed_freshness() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.quota_report() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_coverage() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.run_daily_maintenance() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.market_feed_freshness() TO authenticated, service_role;