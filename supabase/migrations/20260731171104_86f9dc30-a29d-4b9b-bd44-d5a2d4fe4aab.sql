CREATE OR REPLACE FUNCTION public.prune_old_data(_aggressive boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  started timestamptz := clock_timestamp();
  cfg jsonb;
  res jsonb := '{}'::jsonb;
  n integer;
  total integer := 0;
  d_tracked integer;
  d_other integer;
  d_inactive integer;
  size_after bigint;
  mode text := CASE WHEN _aggressive THEN 'aggressive' ELSE 'normal' END;

  simple_targets text[][] := ARRAY[
    ['market_provider_health','created_at'],
    ['market_provider_observations','created_at'],
    ['market_value_audit','checked_at'],
    ['market_indicators_cache','computed_at'],
    ['market_intraday_prices','ts'],
    ['market_ingestion_runs','started_at'],
    ['market_reference_audit_runs','created_at'],
    ['market_ticker_trace','created_at'],
    ['market_alert_events','created_at'],
    ['market_autotrade_log','created_at'],
    ['market_breakout_snapshots','computed_at'],
    ['market_option_chain_snapshots','captured_at'],
    ['market_score_history','trade_date'],
    ['market_news','created_at'],
    ['jarvis_interactions','created_at'],
    ['gmail_sync_runs','created_at'],
    ['detection_runs','created_at']
  ];
  t text; col text; keep_days integer; i integer;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can run maintenance';
  END IF;

  SELECT jsonb_object_agg(c.key, c.days) INTO cfg FROM public.system_retention_config c;

  FOR i IN 1 .. array_length(simple_targets, 1) LOOP
    t := simple_targets[i][1];
    col := simple_targets[i][2];
    keep_days := COALESCE((cfg ->> t)::int, 30);
    IF _aggressive THEN keep_days := GREATEST(1, keep_days / 3); END IF;
    n := public.prune_batched(format(
      'DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I WHERE %I < now() - interval ''%s days'' LIMIT 50000)',
      t, t, col, keep_days));
    IF n > 0 THEN res := res || jsonb_build_object(t, n); total := total + n; END IF;
  END LOOP;

  n := public.prune_batched(format(
    'DELETE FROM public.market_eod_nse WHERE ctid IN (SELECT ctid FROM public.market_eod_nse WHERE trade_date < (SELECT COALESCE(min(d), ''1900-01-01''::date) FROM (SELECT DISTINCT trade_date d FROM public.market_eod_nse ORDER BY d DESC LIMIT %s) x) LIMIT 50000)',
    GREATEST(1, COALESCE((cfg ->> 'market_eod_nse')::int, 5))));
  IF n > 0 THEN res := res || jsonb_build_object('market_eod_nse', n); total := total + n; END IF;

  d_tracked  := COALESCE((cfg ->> 'prices_hot_tracked')::int, 500);
  d_other    := COALESCE((cfg ->> 'prices_hot_other')::int, 260);
  d_inactive := COALESCE((cfg ->> 'prices_inactive')::int, 180);
  IF _aggressive THEN
    d_tracked  := GREATEST(180, d_tracked - 120);
    d_other    := GREATEST(120, d_other - 60);
    d_inactive := GREATEST(90,  d_inactive - 60);
  END IF;

  DROP TABLE IF EXISTS _tracked_symbols;
  -- Benchmark indices are inactive INDEX rows, so they used to fall into the
  -- shortest (inactive) retention bucket. Every benchmark-relative return in
  -- the scoring calibration reads ^NSEI, so their history must live at least
  -- as long as the deepest tracked window.
  CREATE TEMP TABLE _tracked_symbols ON COMMIT DROP AS
    SELECT DISTINCT symbol FROM public.market_watchlist_items
    UNION SELECT symbol FROM public.market_holdings
    UNION SELECT symbol FROM public.market_positions
    UNION SELECT symbol FROM public.market_index_members
    UNION SELECT symbol FROM public.market_stocks WHERE instrument_type = 'INDEX';

  n := public.prune_batched(format(
    'DELETE FROM public.market_daily_prices WHERE ctid IN (
       SELECT p.ctid FROM public.market_daily_prices p
       WHERE p.trade_date < current_date - %s
         AND EXISTS (SELECT 1 FROM _tracked_symbols k WHERE k.symbol = p.symbol)
         AND EXISTS (SELECT 1 FROM public.market_archive_index a WHERE a.symbol = p.symbol AND a.exchange = p.exchange AND a.first_date <= p.trade_date AND a.last_date >= p.trade_date)
       LIMIT 50000)', d_tracked));
  total := total + n;
  res := res || jsonb_build_object('market_daily_prices_tracked', n);

  n := public.prune_batched(format(
    'DELETE FROM public.market_daily_prices WHERE ctid IN (
       SELECT p.ctid FROM public.market_daily_prices p
       WHERE p.trade_date < current_date - %s
         AND NOT EXISTS (SELECT 1 FROM _tracked_symbols k WHERE k.symbol = p.symbol)
         AND EXISTS (SELECT 1 FROM public.market_stocks s WHERE s.symbol = p.symbol AND s.exchange = p.exchange AND s.is_active)
       LIMIT 50000)', d_other));
  total := total + n;
  res := res || jsonb_build_object('market_daily_prices_other', n);

  n := public.prune_batched(format(
    'DELETE FROM public.market_daily_prices WHERE ctid IN (
       SELECT p.ctid FROM public.market_daily_prices p
       WHERE p.trade_date < current_date - %s
         AND NOT EXISTS (SELECT 1 FROM _tracked_symbols k WHERE k.symbol = p.symbol)
         AND NOT EXISTS (SELECT 1 FROM public.market_stocks s WHERE s.symbol = p.symbol AND s.exchange = p.exchange AND s.is_active)
       LIMIT 50000)', d_inactive));
  total := total + n;
  res := res || jsonb_build_object('market_daily_prices_inactive', n);

  n := public.prune_batched(
    'DELETE FROM public.market_daily_prices WHERE ctid IN (
       SELECT p.ctid FROM public.market_daily_prices p
       WHERE NOT EXISTS (SELECT 1 FROM public.market_stocks s WHERE s.symbol = p.symbol AND s.exchange = p.exchange)
       LIMIT 50000)');
  IF n > 0 THEN
    total := total + n;
    res := res || jsonb_build_object('market_daily_prices_orphans', n);
  END IF;

  DROP TABLE IF EXISTS _tracked_symbols;

  size_after := pg_database_size(current_database());

  INSERT INTO public.system_maintenance_log (mode, rows_deleted, total_deleted, size_bytes, duration_ms)
  VALUES (mode, res, total, size_after,
          (EXTRACT(EPOCH FROM (clock_timestamp() - started)) * 1000)::int);

  RETURN jsonb_build_object('mode', mode, 'total_deleted', total,
                            'size_bytes', size_after, 'rows_deleted', res);
END;
$function$;