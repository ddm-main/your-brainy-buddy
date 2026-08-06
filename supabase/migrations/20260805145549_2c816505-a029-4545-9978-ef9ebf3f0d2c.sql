CREATE OR REPLACE FUNCTION public.prune_beyond_history_ceiling()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  started timestamptz := clock_timestamp();
  keep_days integer;
  cutoff date;
  cutoff_ts timestamptz;
  res jsonb := '{}'::jsonb;
  total integer := 0;
  n integer;
  t text; col text; i integer;
  date_targets text[][] := ARRAY[
    ['market_daily_prices','trade_date'],
    ['market_eod_nse','trade_date'],
    ['market_score_history','trade_date'],
    ['market_score_distribution','trade_date'],
    ['market_breadth_daily','trade_date'],
    ['market_sector_strength_daily','trade_date'],
    ['market_realized_pnl_daily','day'],
    ['nav_history','nav_date']
  ];
  ts_targets text[][] := ARRAY[
    ['market_intraday_prices','ts'],
    ['market_indicators_cache','computed_at'],
    ['market_breakout_snapshots','computed_at'],
    ['market_news','created_at'],
    ['market_provider_observations','created_at'],
    ['market_value_audit','checked_at'],
    ['market_ingestion_runs','started_at'],
    ['market_option_chain_snapshots','captured_at']
  ];
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can run maintenance';
  END IF;

  SELECT COALESCE(MAX(days), 730) INTO keep_days
  FROM public.system_retention_config WHERE key = 'max_history_days';
  keep_days := GREATEST(90, keep_days);
  cutoff := (current_date - keep_days)::date;
  cutoff_ts := (current_date - keep_days)::timestamptz;

  FOR i IN 1 .. array_length(date_targets, 1) LOOP
    t := date_targets[i][1]; col := date_targets[i][2];
    n := public.prune_batched(format(
      'DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I WHERE %I < %L::date LIMIT 50000)',
      t, t, col, cutoff));
    IF n > 0 THEN res := res || jsonb_build_object(t, n); total := total + n; END IF;
  END LOOP;

  FOR i IN 1 .. array_length(ts_targets, 1) LOOP
    t := ts_targets[i][1]; col := ts_targets[i][2];
    n := public.prune_batched(format(
      'DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I WHERE %I < %L::timestamptz LIMIT 50000)',
      t, t, col, cutoff_ts));
    IF n > 0 THEN res := res || jsonb_build_object(t, n); total := total + n; END IF;
  END LOOP;

  SELECT count(*)::int INTO n
  FROM public.market_archive_index a
  LEFT JOIN public.market_stocks s ON s.symbol = a.symbol AND s.exchange = a.exchange
  WHERE a.last_date < cutoff OR COALESCE(s.penny_excluded, false) = true;
  res := res || jsonb_build_object('archives_expired', COALESCE(n, 0));

  INSERT INTO public.system_maintenance_log (mode, rows_deleted, total_deleted, duration_ms)
  VALUES ('history_ceiling',
          res || jsonb_build_object('cutoff', cutoff, 'keep_days', keep_days),
          total,
          (EXTRACT(epoch FROM clock_timestamp() - started) * 1000)::int);

  RETURN res || jsonb_build_object('cutoff', cutoff, 'keep_days', keep_days, 'rows_deleted', total);
END;
$function$;