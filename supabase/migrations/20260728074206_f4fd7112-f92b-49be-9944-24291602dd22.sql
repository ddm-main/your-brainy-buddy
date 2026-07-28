-- Retention configuration -----------------------------------------------
CREATE TABLE public.system_retention_config (
  key text PRIMARY KEY,
  days integer NOT NULL CHECK (days > 0),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.system_retention_config TO authenticated;
GRANT ALL ON public.system_retention_config TO service_role;
ALTER TABLE public.system_retention_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage retention config" ON public.system_retention_config
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER system_retention_config_updated_at
  BEFORE UPDATE ON public.system_retention_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.system_retention_config (key, days, note) VALUES
  ('market_provider_health',        3,    'provider call debug log'),
  ('market_provider_observations',  14,   'metric provenance audit'),
  ('market_value_audit',            14,   'reference parity audit'),
  ('market_indicators_cache',       10,   'derived indicator series'),
  ('market_intraday_prices',        7,    'intraday bars'),
  ('market_eod_nse',                5,    'bhavcopy staging'),
  ('market_ingestion_runs',         14,   'pipeline run log'),
  ('market_reference_audit_runs',   14,   'audit run log'),
  ('market_ticker_trace',           14,   'ticker trace'),
  ('market_alert_events',           14,   'fired alert events'),
  ('market_autotrade_log',          14,   'autotrade log'),
  ('market_breakout_snapshots',     30,   'breakout snapshots'),
  ('market_option_chain_snapshots', 7,    'option chain snapshots'),
  ('market_news',                   30,   'market news'),
  ('jarvis_interactions',           30,   'jarvis chat history'),
  ('gmail_sync_runs',               30,   'gmail sync log'),
  ('detection_runs',                30,   'finance detection log'),
  ('prices_tracked',                3650, 'daily price history for watched/held/index symbols'),
  ('prices_other',                  1095, 'daily price history for other active symbols'),
  ('prices_inactive',               365,  'daily price history for inactive symbols');

-- Maintenance log ---------------------------------------------------------
CREATE TABLE public.system_maintenance_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz NOT NULL DEFAULT now(),
  mode text NOT NULL DEFAULT 'normal',
  rows_deleted jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_deleted integer NOT NULL DEFAULT 0,
  size_bytes bigint,
  duration_ms integer
);

CREATE INDEX idx_system_maintenance_log_ran_at ON public.system_maintenance_log (ran_at DESC);
GRANT SELECT ON public.system_maintenance_log TO authenticated;
GRANT ALL ON public.system_maintenance_log TO service_role;
ALTER TABLE public.system_maintenance_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read maintenance log" ON public.system_maintenance_log
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Size report -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.db_size_report()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.db_size_report() FROM public;
GRANT EXECUTE ON FUNCTION public.db_size_report() TO authenticated, service_role;

-- Batched delete helper ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.prune_batched(_sql text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer := 0;
  total integer := 0;
BEGIN
  LOOP
    EXECUTE _sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    EXIT WHEN n = 0 OR total > 2000000;
  END LOOP;
  RETURN total;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_batched(text) FROM public;

-- Daily janitor -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prune_old_data(_aggressive boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  t text; col text; days integer; i integer;
BEGIN
  -- Only admins may invoke this interactively; cron runs with no auth context.
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can run maintenance';
  END IF;

  SELECT jsonb_object_agg(key, days) INTO cfg FROM public.system_retention_config;

  FOR i IN 1 .. array_length(simple_targets, 1) LOOP
    t := simple_targets[i][1];
    col := simple_targets[i][2];
    days := COALESCE((cfg ->> t)::int, 30);
    IF _aggressive THEN days := GREATEST(1, days / 3); END IF;
    n := public.prune_batched(format(
      'DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I WHERE %I < now() - interval ''%s days'' LIMIT 50000)',
      t, t, col, days));
    IF n > 0 THEN res := res || jsonb_build_object(t, n); total := total + n; END IF;
  END LOOP;

  -- Bhavcopy staging: keep the last N trading dates only.
  n := public.prune_batched(format(
    'DELETE FROM public.market_eod_nse WHERE ctid IN (SELECT ctid FROM public.market_eod_nse WHERE trade_date < (SELECT COALESCE(min(d), ''1900-01-01''::date) FROM (SELECT DISTINCT trade_date d FROM public.market_eod_nse ORDER BY d DESC LIMIT %s) x) LIMIT 50000)',
    GREATEST(1, COALESCE((cfg ->> 'market_eod_nse')::int, 5))));
  IF n > 0 THEN res := res || jsonb_build_object('market_eod_nse', n); total := total + n; END IF;

  -- Tiered daily price history.
  d_tracked  := COALESCE((cfg ->> 'prices_tracked')::int, 3650);
  d_other    := COALESCE((cfg ->> 'prices_other')::int, 1095);
  d_inactive := COALESCE((cfg ->> 'prices_inactive')::int, 365);
  IF _aggressive THEN
    d_tracked  := LEAST(d_tracked, 1825);
    d_other    := LEAST(d_other, 730);
    d_inactive := LEAST(d_inactive, 365);
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

  size_after := pg_database_size(current_database());

  INSERT INTO public.system_maintenance_log (mode, rows_deleted, total_deleted, size_bytes, duration_ms)
  VALUES (mode, res, total, size_after,
          (EXTRACT(EPOCH FROM (clock_timestamp() - started)) * 1000)::int);

  RETURN jsonb_build_object('mode', mode, 'total_deleted', total,
                            'size_bytes', size_after, 'rows_deleted', res);
END;
$$;

REVOKE ALL ON FUNCTION public.prune_old_data(boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.prune_old_data(boolean) TO authenticated, service_role;

-- Daily entrypoint used by cron: normal pass, then escalate if still large.
CREATE OR REPLACE FUNCTION public.run_daily_maintenance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  first jsonb;
  second jsonb := NULL;
  threshold bigint := 460 * 1024 * 1024;
BEGIN
  first := public.prune_old_data(false);
  IF (first ->> 'size_bytes')::bigint > threshold THEN
    second := public.prune_old_data(true);
  END IF;
  RETURN jsonb_build_object('normal', first, 'aggressive', second);
END;
$$;

REVOKE ALL ON FUNCTION public.run_daily_maintenance() FROM public;
GRANT EXECUTE ON FUNCTION public.run_daily_maintenance() TO service_role;