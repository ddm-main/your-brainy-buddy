CREATE OR REPLACE FUNCTION public.market_penny_sweep(_min_cap_cr numeric DEFAULT 1000, _min_price numeric DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _trade_date date;
  _excluded int := 0;
  _reinstated int := 0;
  _evaluated int := 0;
  _snapshot int := NULL;
  _started timestamptz := now();
BEGIN
  SELECT max(trade_date) INTO _trade_date FROM public.market_daily_prices;
  IF _trade_date IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no settled prices');
  END IF;

  CREATE TEMP TABLE _penny_eval ON COMMIT DROP AS
  SELECT s.symbol,
         s.exchange,
         s.penny_excluded,
         s.in_universe,
         CASE
           WHEN (s.market_cap IS NOT NULL AND s.market_cap < _min_cap_cr)
                AND (p.close IS NOT NULL AND p.close < _min_price)
             THEN 'cap<' || _min_cap_cr::int || 'cr+ltp<' || _min_price::int
           WHEN (s.market_cap IS NOT NULL AND s.market_cap < _min_cap_cr)
             THEN 'cap<' || _min_cap_cr::int || 'cr'
           WHEN (p.close IS NOT NULL AND p.close < _min_price)
             THEN 'ltp<' || _min_price::int
           ELSE NULL
         END AS reason
  FROM public.market_stocks s
  LEFT JOIN public.market_daily_prices p
    ON p.symbol = s.symbol AND p.trade_date = _trade_date
  WHERE s.is_active = true;

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

  WITH upd AS (
    UPDATE public.market_stocks s
       SET penny_excluded = false,
           penny_reason = NULL,
           penny_checked_at = now(),
           in_universe = true
      FROM _penny_eval e
     WHERE e.symbol = s.symbol AND e.exchange = s.exchange
       AND e.reason IS NULL
       AND s.penny_excluded IS true
    RETURNING 1
  ) SELECT count(*) INTO _reinstated FROM upd;

  IF _excluded > 0 OR _reinstated > 0 THEN
    SELECT public.refresh_market_screener_snapshot() INTO _snapshot;
  END IF;

  INSERT INTO public.market_ingestion_runs (source, stage, status, rows_ingested, duration_ms, metadata, finished_at)
  VALUES ('penny_sweep', 'sweep', 'ok', _excluded + _reinstated,
          (extract(epoch FROM (now() - _started)) * 1000)::int,
          jsonb_build_object('trade_date', _trade_date, 'evaluated', _evaluated,
                             'excluded', _excluded, 'reinstated', _reinstated,
                             'min_market_cap_cr', _min_cap_cr, 'min_price', _min_price,
                             'snapshot_rows', _snapshot),
          now());

  RETURN jsonb_build_object('ok', true, 'trade_date', _trade_date, 'evaluated', _evaluated,
                            'excluded', _excluded, 'reinstated', _reinstated, 'snapshot_rows', _snapshot);
END;
$$;

REVOKE ALL ON FUNCTION public.market_penny_sweep(numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_penny_sweep(numeric, numeric) TO service_role;