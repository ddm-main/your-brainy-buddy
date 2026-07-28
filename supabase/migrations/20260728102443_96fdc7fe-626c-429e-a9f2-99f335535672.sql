
-- 1. Index diet ---------------------------------------------------------
DROP INDEX IF EXISTS public.idx_market_provider_health_provider_created;
DROP INDEX IF EXISTS public.idx_market_provider_health_endpoint_created;
CREATE INDEX IF NOT EXISTS brin_market_provider_health_created
  ON public.market_provider_health USING brin (created_at);

-- Duplicate of the (symbol, exchange, trade_date) unique index.
DROP INDEX IF EXISTS public.idx_mdp_symbol_date_adj;
CREATE INDEX IF NOT EXISTS brin_market_daily_prices_trade_date
  ON public.market_daily_prices USING brin (trade_date);

DROP INDEX IF EXISTS public.market_value_audit_symbol_field_idx;

-- 2. Archive picker: only symbols that still hold cold rows -------------
CREATE OR REPLACE FUNCTION public.market_archive_candidates(
  _limit integer DEFAULT 40,
  _hot_tracked integer DEFAULT 730,
  _hot_other integer DEFAULT 400
)
RETURNS TABLE(symbol text, exchange text, cutoff date, cold_bars integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH tracked AS (
    SELECT DISTINCT s FROM (
      SELECT symbol s FROM public.market_watchlist_items
      UNION SELECT symbol FROM public.market_holdings
      UNION SELECT symbol FROM public.market_positions
      UNION SELECT symbol FROM public.market_index_members
    ) x
  ), base AS (
    SELECT st.symbol,
           st.exchange,
           (current_date - CASE WHEN t.s IS NOT NULL
                                THEN GREATEST(180, _hot_tracked)
                                ELSE GREATEST(120, _hot_other) END)::date AS cutoff,
           a.updated_at AS archived_at
    FROM public.market_stocks st
    LEFT JOIN tracked t ON t.s = st.symbol
    LEFT JOIN public.market_archive_index a
           ON a.symbol = st.symbol AND a.exchange = st.exchange
    WHERE st.is_active = true
      AND st.exchange = 'NSE'
  )
  SELECT b.symbol, b.exchange, b.cutoff, 0::int
  FROM base b
  WHERE EXISTS (
    SELECT 1 FROM public.market_daily_prices p
    WHERE p.symbol = b.symbol
      AND p.exchange = b.exchange
      AND p.trade_date < b.cutoff
  )
  ORDER BY b.archived_at ASC NULLS FIRST, b.symbol ASC
  LIMIT GREATEST(1, LEAST(_limit, 200))
$function$;

-- 3. Backfill picker: never fetch what retention/archive will remove ----
CREATE OR REPLACE FUNCTION public.market_history_backfill_candidates(
  _limit integer DEFAULT 40,
  _min_bars integer DEFAULT 750
)
RETURNS TABLE(symbol text, exchange text, yahoo_symbol text, bars integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  )
  SELECT s.symbol,
         s.exchange,
         s.yahoo_symbol,
         COALESCE(d.bars, 0)::int AS bars
  FROM public.market_stocks s
  CROSS JOIN cfg
  LEFT JOIN tracked t ON t.s = s.symbol
  LEFT JOIN (
    SELECT p.symbol, p.exchange, COUNT(*)::int AS bars
    FROM public.market_daily_prices p
    GROUP BY p.symbol, p.exchange
  ) d ON d.symbol = s.symbol AND d.exchange = s.exchange
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND NOT EXISTS (
      SELECT 1 FROM public.market_archive_index a
      WHERE a.symbol = s.symbol AND a.exchange = s.exchange
    )
    -- Target depth is whatever the hot window allows (trading days ~ 0.7 * calendar days).
    AND COALESCE(d.bars, 0) < LEAST(
          GREATEST(30, _min_bars),
          (CASE WHEN t.s IS NOT NULL THEN cfg.hot_tracked ELSE cfg.hot_other END * 0.68)::int
        )
    AND (
      COALESCE(s.history_backfill_attempts, 0) < 5
      OR COALESCE(s.history_backfill_attempted_at, '1970-01-01'::timestamptz) < now() - interval '7 days'
    )
  ORDER BY s.history_backfill_attempted_at ASC NULLS FIRST,
           COALESCE(d.bars, 0) ASC,
           s.symbol ASC
  LIMIT GREATEST(1, LEAST(_limit, 200))
$function$;

-- 4. Pruner driven by the hot window ------------------------------------
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

  -- Hot window is the source of truth: anything older lives in file storage.
  d_tracked  := COALESCE((cfg ->> 'prices_hot_tracked')::int, 500);
  d_other    := COALESCE((cfg ->> 'prices_hot_other')::int, 260);
  d_inactive := COALESCE((cfg ->> 'prices_inactive')::int, 180);
  IF _aggressive THEN
    d_tracked  := GREATEST(180, d_tracked - 120);
    d_other    := GREATEST(120, d_other - 60);
    d_inactive := GREATEST(90,  d_inactive - 60);
  END IF;

  CREATE TEMP TABLE _tracked_symbols ON COMMIT DROP AS
    SELECT DISTINCT symbol FROM public.market_watchlist_items
    UNION SELECT symbol FROM public.market_holdings
    UNION SELECT symbol FROM public.market_positions
    UNION SELECT symbol FROM public.market_index_members;

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

  -- Price rows for symbols that no longer exist in the universe at all.
  n := public.prune_batched(
    'DELETE FROM public.market_daily_prices WHERE ctid IN (
       SELECT p.ctid FROM public.market_daily_prices p
       WHERE NOT EXISTS (SELECT 1 FROM public.market_stocks s WHERE s.symbol = p.symbol AND s.exchange = p.exchange)
       LIMIT 50000)');
  IF n > 0 THEN
    total := total + n;
    res := res || jsonb_build_object('market_daily_prices_orphans', n);
  END IF;

  size_after := pg_database_size(current_database());

  INSERT INTO public.system_maintenance_log (mode, rows_deleted, total_deleted, size_bytes, duration_ms)
  VALUES (mode, res, total, size_after,
          (EXTRACT(EPOCH FROM (clock_timestamp() - started)) * 1000)::int);

  RETURN jsonb_build_object('mode', mode, 'total_deleted', total,
                            'size_bytes', size_after, 'rows_deleted', res);
END;
$function$;

-- 5. Three-band governor -------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_daily_maintenance()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  first jsonb;
  second jsonb := NULL;
  db_bytes bigint;
  store_bytes bigint;
  level text := 'ok';
  amber bigint := 380 * 1024 * 1024;
  red   bigint := 430 * 1024 * 1024;
BEGIN
  first := public.prune_old_data(false);
  db_bytes := (first ->> 'size_bytes')::bigint;

  IF db_bytes > amber THEN
    level := 'warn';
    second := public.prune_old_data(true);
    db_bytes := (second ->> 'size_bytes')::bigint;
  END IF;

  IF db_bytes > red THEN
    level := 'critical';
    -- Emergency: derived caches and diagnostics down to a single day and the
    -- hot price window permanently shortened by 60 days.
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
    db_bytes := pg_database_size(current_database());
  END IF;

  SELECT COALESCE(SUM((o.metadata->>'size')::bigint), 0) INTO store_bytes FROM storage.objects o;

  UPDATE public.system_quota_state
     SET db_bytes = run_daily_maintenance.db_bytes,
         storage_bytes = store_bytes,
         last_level = level,
         low_bandwidth = (level = 'critical'),
         checked_at = now(),
         updated_at = now()
   WHERE id;

  RETURN jsonb_build_object('level', level, 'db_bytes', db_bytes,
                            'storage_bytes', store_bytes,
                            'normal', first, 'aggressive', second);
END;
$function$;

-- 6. Archive coverage for the quota panel --------------------------------
CREATE OR REPLACE FUNCTION public.archive_coverage()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'archived', (SELECT count(*) FROM public.market_archive_index),
    'universe', (SELECT count(*) FROM public.market_stocks WHERE is_active AND exchange = 'NSE'),
    'archived_bars', (SELECT COALESCE(sum(bars), 0) FROM public.market_archive_index),
    'archived_bytes', (SELECT COALESCE(sum(bytes), 0) FROM public.market_archive_index),
    'pending', (SELECT count(*) FROM public.market_archive_candidates(200, 500, 260))
  )
$function$;

GRANT EXECUTE ON FUNCTION public.archive_coverage() TO authenticated;
