CREATE OR REPLACE FUNCTION public.market_penny_sweep(_min_cap_cr numeric DEFAULT 1000, _min_price numeric DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _trade_date date;
  _floor_date date;
  _excluded int := 0;
  _reinstated int := 0;
  _evaluated int := 0;
  _purged int := 0;
  _unknown_cap int := 0;
  _unknown_price int := 0;
  _universe int := 0;
  _snapshot int := NULL;
  _snapshot_error text := NULL;
  _started timestamptz := now();
  _newly text[];
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

  -- Last known close per SYMBOL (exchange-agnostic): an exchange mismatch must
  -- never make a low-priced stock look priceless and therefore clean.
  CREATE TEMP TABLE _penny_eval ON COMMIT DROP AS
  WITH last_px AS (
    SELECT DISTINCT ON (p.symbol)
           p.symbol, p.close
    FROM public.market_daily_prices p
    WHERE p.trade_date >= _floor_date
      AND p.close IS NOT NULL
    ORDER BY p.symbol, p.trade_date DESC
  )
  SELECT s.symbol,
         s.exchange,
         s.is_active,
         s.penny_excluded AS was_penny,
         (s.market_cap IS NULL) AS cap_unknown,
         (lp.close IS NULL)     AS price_unknown,
         CASE
           WHEN (s.market_cap IS NOT NULL AND s.market_cap < _min_cap_cr)
                AND (lp.close IS NOT NULL AND lp.close < _min_price)
             THEN 'cap<' || _min_cap_cr::int || 'cr+ltp<' || _min_price::int
           WHEN (s.market_cap IS NOT NULL AND s.market_cap < _min_cap_cr)
             THEN 'cap<' || _min_cap_cr::int || 'cr'
           WHEN (lp.close IS NOT NULL AND lp.close < _min_price)
             THEN 'ltp<' || _min_price::int
           ELSE NULL
         END AS reason,
         -- Positive proof of a clean stock: BOTH metrics known and passing.
         (s.market_cap IS NOT NULL AND s.market_cap >= _min_cap_cr
          AND lp.close IS NOT NULL AND lp.close >= _min_price) AS proven_clean
  FROM public.market_stocks s
  LEFT JOIN last_px lp ON lp.symbol = s.symbol;

  SELECT count(*),
         count(*) FILTER (WHERE is_active AND cap_unknown AND reason IS NULL),
         count(*) FILTER (WHERE is_active AND price_unknown AND reason IS NULL)
    INTO _evaluated, _unknown_cap, _unknown_price
  FROM _penny_eval;

  -- Symbols crossing into penny status on this run — their history gets purged.
  SELECT array_agg(symbol) INTO _newly
  FROM (SELECT DISTINCT symbol FROM _penny_eval
        WHERE reason IS NOT NULL AND was_penny IS DISTINCT FROM true) q;

  -- One pass over every evaluated row. Doing flag, reason, check date and
  -- universe membership together is what keeps them from drifting apart: the
  -- previous three-branch version left `in_universe` false on every clean
  -- stock, so the column claimed an empty universe while the market_universe
  -- view (active AND NOT penny) served 1,600+ names.
  --   * reason present            -> penny, out of the universe
  --   * proven clean              -> not penny, in the universe when active
  --   * unproven (cap or price
  --     unknown but not failing)  -> flag unchanged; membership still mirrors
  --                                  the view so column and view agree
  WITH ev AS (
    SELECT e.*,
           CASE WHEN e.reason IS NOT NULL THEN true
                WHEN e.proven_clean THEN false
                ELSE COALESCE(e.was_penny, false) END AS next_penny
    FROM _penny_eval e
  ), upd AS (
    UPDATE public.market_stocks s
       SET penny_excluded  = ev.next_penny,
           penny_reason    = CASE WHEN ev.next_penny THEN COALESCE(ev.reason, s.penny_reason) ELSE NULL END,
           penny_checked_at = now(),
           in_universe     = (COALESCE(s.is_active, true) AND NOT ev.next_penny),
           updated_at      = now()
      FROM ev
     WHERE ev.symbol = s.symbol AND ev.exchange = s.exchange
    RETURNING ev.next_penny, COALESCE(ev.was_penny, false) AS prev_penny
  )
  SELECT count(*) FILTER (WHERE next_penny AND NOT prev_penny),
         count(*) FILTER (WHERE NOT next_penny AND prev_penny)
    INTO _excluded, _reinstated
  FROM upd;

  IF _newly IS NOT NULL THEN
    _purged := public.market_penny_purge(_newly);
  END IF;

  IF _excluded > 0 OR _reinstated > 0 THEN
    BEGIN
      SELECT public.refresh_market_screener_snapshot() INTO _snapshot;
    EXCEPTION WHEN OTHERS THEN
      _snapshot_error := SQLERRM;
    END;
  END IF;

  SELECT count(*) INTO _universe FROM public.market_universe;

  INSERT INTO public.market_ingestion_runs (source, stage, status, rows_ingested, duration_ms, metadata, finished_at)
  VALUES ('penny_sweep', 'sweep', CASE WHEN _snapshot_error IS NULL THEN 'ok' ELSE 'partial' END,
          _excluded + _reinstated,
          (extract(epoch FROM (now() - _started)) * 1000)::int,
          jsonb_build_object('trade_date', _trade_date, 'price_floor_date', _floor_date,
                             'evaluated', _evaluated,
                             'excluded', _excluded, 'reinstated', _reinstated,
                             'purged_rows', _purged,
                             'universe', _universe,
                             'unknown_cap', _unknown_cap, 'unknown_price', _unknown_price,
                             'min_market_cap_cr', _min_cap_cr, 'min_price', _min_price,
                             'snapshot_rows', _snapshot, 'snapshot_error', _snapshot_error),
          now());

  INSERT INTO public.system_maintenance_log (mode, rows_deleted, total_deleted, duration_ms)
  VALUES ('penny_sweep',
          jsonb_build_object('excluded', _excluded, 'reinstated', _reinstated,
                             'evaluated', _evaluated, 'trade_date', _trade_date,
                             'purged_rows', _purged, 'universe', _universe,
                             'unknown_cap', _unknown_cap, 'unknown_price', _unknown_price,
                             'snapshot_error', _snapshot_error),
          _excluded,
          (extract(epoch FROM (now() - _started)) * 1000)::int);

  RETURN jsonb_build_object('ok', true, 'trade_date', _trade_date, 'price_floor_date', _floor_date,
                            'evaluated', _evaluated,
                            'excluded', _excluded, 'reinstated', _reinstated,
                            'purged_rows', _purged, 'universe', _universe,
                            'unknown_cap', _unknown_cap, 'unknown_price', _unknown_price,
                            'snapshot_rows', _snapshot, 'snapshot_error', _snapshot_error);
END;
$function$;