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