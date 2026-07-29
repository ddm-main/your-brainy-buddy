-- 1. Security definer views -> invoker
ALTER VIEW public.market_screener_live SET (security_invoker = on);
ALTER VIEW public.market_screener_rows SET (security_invoker = on);
ALTER VIEW public.market_data_freshness SET (security_invoker = on);

-- 2. Revoke anon/public execute on privileged SECURITY DEFINER functions
REVOKE ALL ON FUNCTION public.prune_batched(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_archive_candidates(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quota_report() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.db_size_report() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.archive_coverage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.prune_old_data(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.run_daily_maintenance() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prune_batched(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.market_archive_candidates(integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.quota_report() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.db_size_report() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_coverage() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prune_old_data(boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.run_daily_maintenance() TO authenticated, service_role;

-- 3. In-function admin guards for the reporting helpers
CREATE OR REPLACE FUNCTION public.quota_report()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
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
          FROM storage.objects o GROUP BY o.bucket_id ORDER BY 3 DESC
        ) b
      ), '[]'::jsonb),
      'tables', COALESCE((
        SELECT jsonb_agg(t) FROM (
          SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','m')
          ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10
        ) t
      ), '[]'::jsonb),
      'quota', COALESCE((SELECT to_jsonb(q) FROM public.system_quota_state q LIMIT 1), '{}'::jsonb)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.db_size_report()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can read database size reports';
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'total_bytes', pg_database_size(current_database()),
      'tables', COALESCE((
        SELECT jsonb_agg(t) FROM (
          SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','m')
          ORDER BY pg_total_relation_size(c.oid) DESC
          LIMIT 10
        ) t
      ), '[]'::jsonb)
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
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
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
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
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

REVOKE ALL ON FUNCTION public.quota_report() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.db_size_report() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.archive_coverage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.run_daily_maintenance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quota_report() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.db_size_report() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_coverage() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.run_daily_maintenance() TO authenticated, service_role;