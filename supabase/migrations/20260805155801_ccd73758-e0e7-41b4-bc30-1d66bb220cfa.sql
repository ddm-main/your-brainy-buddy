CREATE OR REPLACE FUNCTION public.market_penny_sweep(_min_cap_cr numeric DEFAULT 1000, _min_price numeric DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _trade_date date;
  _floor_date date;
  _excluded int := 0;
  _reinstated int := 0;
  _evaluated int := 0;
  _snapshot int := NULL;
  _snapshot_error text := NULL;
  _started timestamptz := now();
BEGIN
  SELECT max(trade_date) INTO _trade_date FROM public.market_daily_prices;
  IF _trade_date IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no settled prices');
  END IF;

  SELECT min(d) INTO _floor_date
  FROM (
    SELECT DISTINCT trade_date AS d
    FROM public.market_daily_prices
    WHERE trade_date <= _trade_date
    ORDER BY 1 DESC
    LIMIT 10
  ) x;

  CREATE TEMP TABLE _penny_eval ON COMMIT DROP AS
  WITH last_px AS (
    SELECT DISTINCT ON (p.symbol, p.exchange)
           p.symbol, p.exchange, p.close, p.trade_date
    FROM public.market_daily_prices p
    WHERE p.trade_date >= _floor_date
      AND p.close IS NOT NULL
    ORDER BY p.symbol, p.exchange, p.trade_date DESC
  )
  SELECT s.symbol,
         s.exchange,
         s.is_active,
         CASE
           WHEN (s.market_cap IS NOT NULL AND s.market_cap < _min_cap_cr)
                AND (lp.close IS NOT NULL AND lp.close < _min_price)
             THEN 'cap<' || _min_cap_cr::int || 'cr+ltp<' || _min_price::int
           WHEN (s.market_cap IS NOT NULL AND s.market_cap < _min_cap_cr)
             THEN 'cap<' || _min_cap_cr::int || 'cr'
           WHEN (lp.close IS NOT NULL AND lp.close < _min_price)
             THEN 'ltp<' || _min_price::int
           ELSE NULL
         END AS reason
  FROM public.market_stocks s
  LEFT JOIN last_px lp
    ON lp.symbol = s.symbol AND lp.exchange = s.exchange;

  SELECT count(*) INTO _evaluated FROM _penny_eval;

  WITH upd AS (
    UPDATE public.market_stocks s
       SET penny_excluded = true,
           penny_reason = e.reason,
           penny_checked_at = now(),
           in_universe = false
      FROM _penny_eval e
     WHERE e.symbol = s.symbol AND e.exchange = s.exchange
       AND e.reason IS NOT NULL
       AND (s.penny_excluded IS DISTINCT FROM true
            OR s.penny_reason IS DISTINCT FROM e.reason
            OR s.in_universe IS true)
    RETURNING 1
  ) SELECT count(*) INTO _excluded FROM upd;

  -- clean symbols: stamp the check; only active ones re-enter the universe
  WITH upd AS (
    UPDATE public.market_stocks s
       SET penny_excluded = false,
           penny_reason = NULL,
           penny_checked_at = now(),
           in_universe = CASE WHEN e.is_active THEN true ELSE false END
      FROM _penny_eval e
     WHERE e.symbol = s.symbol AND e.exchange = s.exchange
       AND e.reason IS NULL
       AND (s.penny_excluded IS DISTINCT FROM false
            OR s.penny_reason IS NOT NULL
            OR s.penny_checked_at IS NULL
            OR s.penny_checked_at < _started)
    RETURNING (s.penny_excluded IS DISTINCT FROM false) AS was_penny
  ) SELECT count(*) FILTER (WHERE was_penny) INTO _reinstated FROM upd;

  IF _excluded > 0 OR _reinstated > 0 THEN
    BEGIN
      SELECT public.refresh_market_screener_snapshot() INTO _snapshot;
    EXCEPTION WHEN OTHERS THEN
      _snapshot_error := SQLERRM;
    END;
  END IF;

  INSERT INTO public.market_ingestion_runs (source, stage, status, rows_ingested, duration_ms, metadata, finished_at)
  VALUES ('penny_sweep', 'sweep', CASE WHEN _snapshot_error IS NULL THEN 'ok' ELSE 'partial' END,
          _excluded + _reinstated,
          (extract(epoch FROM (now() - _started)) * 1000)::int,
          jsonb_build_object('trade_date', _trade_date, 'price_floor_date', _floor_date,
                             'evaluated', _evaluated,
                             'excluded', _excluded, 'reinstated', _reinstated,
                             'min_market_cap_cr', _min_cap_cr, 'min_price', _min_price,
                             'snapshot_rows', _snapshot, 'snapshot_error', _snapshot_error),
          now());

  INSERT INTO public.system_maintenance_log (mode, rows_deleted, total_deleted, duration_ms)
  VALUES ('penny_sweep',
          jsonb_build_object('excluded', _excluded, 'reinstated', _reinstated,
                             'evaluated', _evaluated, 'trade_date', _trade_date,
                             'snapshot_error', _snapshot_error),
          _excluded,
          (extract(epoch FROM (now() - _started)) * 1000)::int);

  RETURN jsonb_build_object('ok', true, 'trade_date', _trade_date, 'price_floor_date', _floor_date,
                            'evaluated', _evaluated,
                            'excluded', _excluded, 'reinstated', _reinstated,
                            'snapshot_rows', _snapshot, 'snapshot_error', _snapshot_error);
END;
$fn$;