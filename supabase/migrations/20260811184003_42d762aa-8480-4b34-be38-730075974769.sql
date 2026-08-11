CREATE OR REPLACE FUNCTION public.market_penny_sweep(
  _min_cap_cr numeric DEFAULT 1000, _min_price numeric DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _trade_date date;
  _floor_date date;
  _removed int := 0;
  _purged int := 0;
  _universe int := 0;
  _evaluated int := 0;
  _cap_derived int := 0;
  _snapshot int := NULL;
  _snapshot_error text := NULL;
  _started timestamptz := now();
  _syms text[];
  _by_reason jsonb;
BEGIN
  SELECT max(trade_date) INTO _trade_date FROM public.market_daily_prices;
  IF _trade_date IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no settled prices');
  END IF;

  SELECT min(d) INTO _floor_date FROM (
    SELECT DISTINCT trade_date AS d FROM public.market_daily_prices
    WHERE trade_date <= _trade_date ORDER BY 1 DESC LIMIT 10
  ) x;

  CREATE TEMP TABLE _penny_eval ON COMMIT DROP AS
  WITH last_px AS (
    SELECT DISTINCT ON (p.symbol) p.symbol, p.close
    FROM public.market_daily_prices p
    WHERE p.trade_date >= _floor_date AND p.close IS NOT NULL
    ORDER BY p.symbol, p.trade_date DESC
  ), base AS (
    SELECT s.symbol, s.exchange, s.company_name, s.series, s.is_active,
           lp.close AS last_close,
           COALESCE(s.market_cap,
                    CASE WHEN s.total_shares_cr IS NOT NULL AND lp.close IS NOT NULL
                         THEN s.total_shares_cr * lp.close END) AS cap,
           (s.market_cap IS NULL) AS cap_missing,
           COALESCE(s.shares_sync_attempts, 0) AS shares_attempts,
           public.market_is_non_equity(s.series, s.symbol, s.company_name, s.instrument_type) AS non_equity
    FROM public.market_stocks s
    LEFT JOIN last_px lp ON lp.symbol = s.symbol
    WHERE COALESCE(s.instrument_type, 'EQ') <> 'INDEX'
  )
  SELECT b.*,
         CASE
           WHEN NOT b.is_active THEN 'inactive'
           WHEN b.non_equity THEN 'non_equity'
           WHEN b.cap IS NOT NULL AND b.cap < _min_cap_cr THEN 'cap<' || _min_cap_cr::int || 'cr'
           WHEN b.last_close IS NOT NULL AND b.last_close < _min_price THEN 'ltp<' || _min_price::int
           WHEN b.cap IS NULL AND b.shares_attempts >= 2 THEN 'no_market_cap'
           ELSE NULL
         END AS reason
  FROM base b;

  SELECT count(*), count(*) FILTER (WHERE cap_missing AND cap IS NOT NULL)
    INTO _evaluated, _cap_derived FROM _penny_eval;

  UPDATE public.market_stocks s
     SET market_cap = e.cap,
         market_cap_source = COALESCE(s.market_cap_source, 'derived_shares_x_close'),
         market_cap_calc_at = now(),
         updated_at = now()
    FROM _penny_eval e
   WHERE e.symbol = s.symbol AND e.exchange = s.exchange
     AND e.cap_missing AND e.cap IS NOT NULL;

  SELECT array_agg(DISTINCT symbol) INTO _syms FROM _penny_eval WHERE reason IS NOT NULL;
  SELECT jsonb_object_agg(reason, n) INTO _by_reason
  FROM (SELECT reason, count(*) n FROM _penny_eval WHERE reason IS NOT NULL GROUP BY 1) q;

  INSERT INTO public.market_excluded_symbols (symbol, exchange, reason, company_name, series, market_cap, last_close)
  SELECT e.symbol, e.exchange, e.reason, e.company_name, e.series, e.cap, e.last_close
  FROM _penny_eval e WHERE e.reason IS NOT NULL
  ON CONFLICT (symbol, exchange) DO NOTHING;

  DELETE FROM public.market_stocks s
   USING _penny_eval e
   WHERE e.reason IS NOT NULL AND e.symbol = s.symbol AND e.exchange = s.exchange;
  GET DIAGNOSTICS _removed = ROW_COUNT;

  _purged := public.market_purge_symbols(_syms);

  UPDATE public.market_stocks s
     SET penny_excluded = false,
         penny_reason = NULL,
         penny_checked_at = now(),
         in_universe = COALESCE(s.is_active, true),
         updated_at = now()
   WHERE COALESCE(s.instrument_type, 'EQ') <> 'INDEX';

  SELECT count(*) INTO _universe FROM public.market_stocks
   WHERE in_universe IS TRUE AND COALESCE(instrument_type,'EQ') <> 'INDEX';

  BEGIN
    SELECT public.refresh_market_screener_snapshot() INTO _snapshot;
  EXCEPTION WHEN OTHERS THEN
    _snapshot_error := SQLERRM;
  END;

  INSERT INTO public.system_maintenance_log (mode, total_deleted, duration_ms, details)
  VALUES ('penny_sweep', _removed + _purged,
          (extract(epoch FROM now() - _started) * 1000)::int,
          jsonb_build_object('removed', _removed, 'purged_rows', _purged,
                             'universe', _universe, 'cap_derived', _cap_derived,
                             'by_reason', COALESCE(_by_reason, '{}'::jsonb)));

  RETURN jsonb_build_object(
    'ok', true,
    'trade_date', _trade_date,
    'evaluated', _evaluated,
    'cap_derived', _cap_derived,
    'removed', _removed,
    'by_reason', COALESCE(_by_reason, '{}'::jsonb),
    'purged_rows', _purged,
    'universe', _universe,
    'snapshot_rows', _snapshot,
    'snapshot_error', _snapshot_error,
    'took_ms', (extract(epoch FROM now() - _started) * 1000)::int
  );
END;
$$;