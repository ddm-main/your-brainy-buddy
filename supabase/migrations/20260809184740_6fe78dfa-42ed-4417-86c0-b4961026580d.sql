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
  v_sweep_at timestamptz;
  v_sweep_stale boolean;
  v_stage_deleted bigint := 0;
  v_ind_deleted bigint := 0;
  v_keep_session date;
BEGIN
  IF auth.uid() IS NULL THEN
    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  ELSIF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can run maintenance';
  END IF;

  -- Staging table: only the current session's rows are ever promoted, so older
  -- sessions are dead weight (this table had grown to ~47 MB).
  SELECT max(session_date) INTO v_keep_session FROM public.market_live_price_stage;
  IF v_keep_session IS NOT NULL THEN
    DELETE FROM public.market_live_price_stage WHERE session_date < v_keep_session;
    GET DIAGNOSTICS v_stage_deleted = ROW_COUNT;
  END IF;

  -- Indicator cache: drop entries for symbols that left the active universe.
  DELETE FROM public.market_indicators_cache c
   WHERE NOT EXISTS (
     SELECT 1 FROM public.market_stocks s
      WHERE s.symbol = c.symbol AND s.exchange = c.exchange AND s.is_active
   );
  GET DIAGNOSTICS v_ind_deleted = ROW_COUNT;

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

  SELECT max(created_at) INTO v_sweep_at
    FROM public.market_ingestion_runs
   WHERE source = 'penny_sweep' AND status <> 'error';
  v_sweep_stale := (v_sweep_at IS NULL OR v_sweep_at < now() - interval '8 days');
  IF v_sweep_stale AND v_level = 'ok' THEN
    v_level := 'warn';
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

  INSERT INTO public.system_maintenance_log (mode, rows_deleted, total_deleted, duration_ms)
  SELECT 'penny_sweep_stale',
         jsonb_build_object('last_sweep_at', v_sweep_at),
         0, 0
  WHERE v_sweep_stale;

  RETURN jsonb_build_object('level', v_level, 'db_bytes', v_db_bytes,
                            'storage_bytes', v_store_bytes,
                            'stage_rows_deleted', v_stage_deleted,
                            'indicator_rows_deleted', v_ind_deleted,
                            'penny_sweep_last_at', v_sweep_at,
                            'penny_sweep_stale', v_sweep_stale,
                            'normal', first, 'aggressive', second);
END;
$function$;