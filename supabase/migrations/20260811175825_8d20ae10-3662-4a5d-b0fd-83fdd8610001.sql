CREATE INDEX IF NOT EXISTS market_stocks_penny_excluded_idx
  ON public.market_stocks (symbol) WHERE penny_excluded IS TRUE;

CREATE OR REPLACE FUNCTION public.enforce_penny_exclusion()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     AND COALESCE(NEW.penny_excluded, false) = false
     AND NEW.market_cap IS NOT NULL
     AND NEW.market_cap < 1000 THEN
    NEW.penny_excluded := true;
    NEW.penny_reason := 'cap<1000cr';
    NEW.penny_checked_at := now();
  END IF;

  -- Unproven listing: no market cap on record yet. Not penny-flagged (so
  -- fundamentals can still fill the cap), but kept out of the universe until a
  -- sweep proves it clean.
  IF TG_OP = 'INSERT'
     AND COALESCE(NEW.penny_excluded, false) = false
     AND NEW.market_cap IS NULL THEN
    NEW.in_universe := false;
  END IF;

  IF NEW.penny_excluded THEN
    NEW.in_universe := false;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.market_penny_purge(_symbols text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _tables text[] := ARRAY[
    'market_daily_prices','market_intraday_prices','market_live_prices',
    'market_live_price_stage','market_eod_nse','market_quotes',
    'market_indicators_cache','market_stock_scores','market_score_history',
    'market_fundamentals','market_fundamentals_global','market_shares_outstanding',
    'market_news','market_stock_ai','market_breakout_tracker',
    'market_breakout_snapshots','market_screener_snapshot','market_nse_master'
  ];
  _t text;
  _n int;
  _total int := 0;
BEGIN
  IF _symbols IS NULL OR array_length(_symbols, 1) IS NULL THEN
    RETURN 0;
  END IF;

  FOREACH _t IN ARRAY _tables LOOP
    LOOP
      EXECUTE format(
        'WITH doomed AS (SELECT ctid FROM public.%I WHERE symbol = ANY($1) LIMIT 5000)
           DELETE FROM public.%I t USING doomed d WHERE t.ctid = d.ctid', _t, _t)
        USING _symbols;
      GET DIAGNOSTICS _n = ROW_COUNT;
      _total := _total + _n;
      EXIT WHEN _n = 0;
    END LOOP;
  END LOOP;

  RETURN _total;
END;
$function$;

REVOKE ALL ON FUNCTION public.market_penny_purge(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_penny_purge(text[]) TO service_role;

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

  SELECT count(*) INTO _evaluated FROM _penny_eval;

  -- Symbols crossing into penny status on this run — their history gets purged.
  SELECT array_agg(symbol) INTO _newly
  FROM (SELECT DISTINCT symbol FROM _penny_eval
        WHERE reason IS NOT NULL AND was_penny IS DISTINCT FROM true) q;

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

  -- Only positively proven stocks re-enter. Unproven names (missing cap or
  -- missing price) keep their current flag and stay out of the universe.
  WITH upd AS (
    UPDATE public.market_stocks s
       SET penny_excluded = false,
           penny_reason = NULL,
           penny_checked_at = now(),
           in_universe = CASE WHEN e.is_active THEN true ELSE false END
      FROM _penny_eval e
     WHERE e.symbol = s.symbol AND e.exchange = s.exchange
       AND e.proven_clean
       AND (s.penny_excluded IS DISTINCT FROM false
            OR s.penny_reason IS NOT NULL
            OR s.penny_checked_at IS NULL
            OR s.penny_checked_at < _started)
    RETURNING (s.penny_excluded IS DISTINCT FROM false) AS was_penny
  ) SELECT count(*) FILTER (WHERE was_penny) INTO _reinstated FROM upd;

  -- Unproven and unflagged: keep them out of the universe until proven.
  UPDATE public.market_stocks s
     SET in_universe = false, penny_checked_at = now()
    FROM _penny_eval e
   WHERE e.symbol = s.symbol AND e.exchange = s.exchange
     AND e.reason IS NULL AND NOT e.proven_clean
     AND s.in_universe IS TRUE;

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

  INSERT INTO public.market_ingestion_runs (source, stage, status, rows_ingested, duration_ms, metadata, finished_at)
  VALUES ('penny_sweep', 'sweep', CASE WHEN _snapshot_error IS NULL THEN 'ok' ELSE 'partial' END,
          _excluded + _reinstated,
          (extract(epoch FROM (now() - _started)) * 1000)::int,
          jsonb_build_object('trade_date', _trade_date, 'price_floor_date', _floor_date,
                             'evaluated', _evaluated,
                             'excluded', _excluded, 'reinstated', _reinstated,
                             'purged_rows', _purged,
                             'min_market_cap_cr', _min_cap_cr, 'min_price', _min_price,
                             'snapshot_rows', _snapshot, 'snapshot_error', _snapshot_error),
          now());

  INSERT INTO public.system_maintenance_log (mode, rows_deleted, total_deleted, duration_ms)
  VALUES ('penny_sweep',
          jsonb_build_object('excluded', _excluded, 'reinstated', _reinstated,
                             'evaluated', _evaluated, 'trade_date', _trade_date,
                             'purged_rows', _purged,
                             'snapshot_error', _snapshot_error),
          _excluded,
          (extract(epoch FROM (now() - _started)) * 1000)::int);

  RETURN jsonb_build_object('ok', true, 'trade_date', _trade_date, 'price_floor_date', _floor_date,
                            'evaluated', _evaluated,
                            'excluded', _excluded, 'reinstated', _reinstated,
                            'purged_rows', _purged,
                            'snapshot_rows', _snapshot, 'snapshot_error', _snapshot_error);
END;
$function$;

REVOKE ALL ON FUNCTION public.market_penny_sweep(numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_penny_sweep(numeric, numeric) TO service_role;