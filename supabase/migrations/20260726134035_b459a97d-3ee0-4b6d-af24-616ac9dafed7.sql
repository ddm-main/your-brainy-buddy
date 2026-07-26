CREATE OR REPLACE FUNCTION public.market_asof_candles(_as_of date, _symbols text[], _bars integer DEFAULT 260)
RETURNS TABLE(symbol text, candles jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ranked AS (
    SELECT
      p.symbol,
      p.trade_date,
      COALESCE(p.open_adjusted,  p.open)  AS o,
      COALESCE(p.high_adjusted,  p.high)  AS h,
      COALESCE(p.low_adjusted,   p.low)   AS l,
      COALESCE(p.close_adjusted, p.close) AS c,
      p.volume,
      ROW_NUMBER() OVER (PARTITION BY p.symbol ORDER BY p.trade_date DESC) AS rn
    FROM public.market_daily_prices p
    WHERE p.exchange = 'NSE'
      AND p.symbol = ANY(_symbols)
      AND p.trade_date <= _as_of
      AND COALESCE(p.close_adjusted, p.close) IS NOT NULL
  )
  SELECT r.symbol,
         jsonb_agg(
           jsonb_build_array(r.trade_date, r.o, r.h, r.l, r.c, COALESCE(r.volume, 0))
           ORDER BY r.trade_date ASC
         ) AS candles
  FROM ranked r
  WHERE r.rn <= GREATEST(30, LEAST(_bars, 600))
  GROUP BY r.symbol
$$;

REVOKE ALL ON FUNCTION public.market_asof_candles(date, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_asof_candles(date, text[], integer) TO service_role;

CREATE OR REPLACE FUNCTION public.market_history_backfill_candidates(_limit integer DEFAULT 40, _min_bars integer DEFAULT 260)
RETURNS TABLE(symbol text, exchange text, yahoo_symbol text, bars integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.symbol,
         s.exchange,
         s.yahoo_symbol,
         COALESCE(d.bars, 0)::int AS bars
  FROM public.market_stocks s
  LEFT JOIN (
    SELECT p.symbol, p.exchange, COUNT(*)::int AS bars
    FROM public.market_daily_prices p
    GROUP BY p.symbol, p.exchange
  ) d ON d.symbol = s.symbol AND d.exchange = s.exchange
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND COALESCE(d.bars, 0) < GREATEST(30, LEAST(_min_bars, 600))
  ORDER BY COALESCE(d.bars, 0) DESC, s.symbol ASC
  LIMIT GREATEST(1, LEAST(_limit, 200))
$$;

REVOKE ALL ON FUNCTION public.market_history_backfill_candidates(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_history_backfill_candidates(integer, integer) TO service_role;