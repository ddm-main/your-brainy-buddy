CREATE OR REPLACE FUNCTION public.evaluate_score_history_forward(_limit integer DEFAULT 200000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n integer := 0;
  since date;
BEGIN
  -- Rows are re-targeted when EITHER the absolute return is still missing OR
  -- the benchmark-relative return is missing while the benchmark now has a bar
  -- for that session. Previously only the first case was considered, so every
  -- row evaluated before ^NSEI history existed kept a NULL relative return
  -- forever, which starved the calibration fit.
  SELECT min(trade_date) INTO since
  FROM public.market_score_history h
  WHERE h.fwd_ret_21d IS NULL
     OR (h.fwd_rel_21d IS NULL
         AND EXISTS (SELECT 1 FROM public.market_daily_prices b
                      WHERE b.symbol = '^NSEI' AND b.exchange = 'NSE'
                        AND b.trade_date = h.trade_date));

  IF since IS NULL THEN
    RETURN 0;
  END IF;

  WITH bench AS (
    SELECT p.trade_date,
           row_number() OVER (ORDER BY p.trade_date) AS rn,
           COALESCE(p.close_adjusted, p.close) AS c
    FROM public.market_daily_prices p
    WHERE p.symbol = '^NSEI' AND p.exchange = 'NSE'
      AND p.trade_date >= since
      AND COALESCE(p.close_adjusted, p.close) IS NOT NULL
  ), bench_fwd AS (
    SELECT trade_date,
           (lead(c, 5)  OVER w / NULLIF(c, 0) - 1) * 100 AS r5,
           (lead(c, 10) OVER w / NULLIF(c, 0) - 1) * 100 AS r10,
           (lead(c, 21) OVER w / NULLIF(c, 0) - 1) * 100 AS r21
    FROM bench
    WINDOW w AS (ORDER BY rn)
  ), px AS (
    SELECT p.symbol, p.exchange, p.trade_date,
           COALESCE(p.close_adjusted, p.close) AS c
    FROM public.market_daily_prices p
    WHERE p.exchange = 'NSE'
      AND p.trade_date >= since
      AND COALESCE(p.close_adjusted, p.close) IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.market_score_history s
        WHERE s.symbol = p.symbol AND s.exchange = p.exchange
      )
  ), fwd AS (
    SELECT symbol, exchange, trade_date,
           (lead(c, 5)  OVER w / NULLIF(c, 0) - 1) * 100 AS r5,
           (lead(c, 10) OVER w / NULLIF(c, 0) - 1) * 100 AS r10,
           (lead(c, 21) OVER w / NULLIF(c, 0) - 1) * 100 AS r21
    FROM px
    WINDOW w AS (PARTITION BY symbol, exchange ORDER BY trade_date)
  ), tgt AS (
    SELECT h.id, f.r5, f.r10, f.r21, b.r5 AS br5, b.r10 AS br10, b.r21 AS br21
    FROM public.market_score_history h
    JOIN fwd f
      ON f.symbol = h.symbol AND f.exchange = h.exchange AND f.trade_date = h.trade_date
    LEFT JOIN bench_fwd b ON b.trade_date = h.trade_date
    WHERE (h.fwd_ret_21d IS NULL OR (h.fwd_rel_21d IS NULL AND b.r21 IS NOT NULL))
      AND f.r5 IS NOT NULL
    LIMIT GREATEST(1, _limit)
  )
  UPDATE public.market_score_history h SET
    fwd_ret_5d  = round(t.r5::numeric, 2),
    fwd_ret_10d = round(t.r10::numeric, 2),
    fwd_ret_21d = round(t.r21::numeric, 2),
    fwd_rel_5d  = round((t.r5  - t.br5)::numeric, 2),
    fwd_rel_10d = round((t.r10 - t.br10)::numeric, 2),
    fwd_rel_21d = round((t.r21 - t.br21)::numeric, 2),
    evaluated_at = CASE WHEN t.r21 IS NOT NULL THEN now() ELSE h.evaluated_at END
  FROM tgt t
  WHERE h.id = t.id;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

-- Coverage the Calibration Lab reads before trusting any fit: how wide the
-- matured sample actually is, split by population.
CREATE OR REPLACE FUNCTION public.score_history_coverage(_model text DEFAULT 'breakout_v4'::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'rows', count(*),
    'symbols', count(DISTINCT symbol),
    'sessions', count(DISTINCT trade_date),
    'first_date', min(trade_date),
    'last_date', max(trade_date),
    'matured_21d', count(*) FILTER (WHERE fwd_ret_21d IS NOT NULL),
    'matured_rel_21d', count(*) FILTER (WHERE fwd_rel_21d IS NOT NULL),
    'live_matured', count(*) FILTER (WHERE fwd_rel_21d IS NOT NULL AND context_neutral IS FALSE),
    'live_symbols', count(DISTINCT symbol) FILTER (WHERE fwd_rel_21d IS NOT NULL AND context_neutral IS FALSE),
    'neutral_matured', count(*) FILTER (WHERE fwd_rel_21d IS NOT NULL AND context_neutral IS TRUE),
    'neutral_symbols', count(DISTINCT symbol) FILTER (WHERE fwd_rel_21d IS NOT NULL AND context_neutral IS TRUE),
    'benchmark_bars', (SELECT count(*) FROM public.market_daily_prices WHERE symbol = '^NSEI' AND exchange = 'NSE'),
    'benchmark_first', (SELECT min(trade_date) FROM public.market_daily_prices WHERE symbol = '^NSEI' AND exchange = 'NSE')
  )
  FROM public.market_score_history WHERE model = _model
$function$;

GRANT EXECUTE ON FUNCTION public.score_history_coverage(text) TO authenticated;