CREATE OR REPLACE FUNCTION public.market_score_backfill_candidates(_limit integer DEFAULT 25, _min_rows integer DEFAULT 100)
RETURNS TABLE(symbol text, exchange text, market_cap numeric, sector text, bars integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT s.symbol,
         s.exchange,
         s.market_cap::numeric,
         s.sector,
         (SELECT count(*)::int FROM public.market_daily_prices p
           WHERE p.symbol = s.symbol AND p.exchange = s.exchange) AS bars
  FROM public.market_stocks s
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND (SELECT count(*) FROM public.market_score_history h
          WHERE h.symbol = s.symbol AND h.exchange = s.exchange
            AND h.model = 'breakout_v4') < GREATEST(1, _min_rows)
    AND (SELECT count(*) FROM public.market_daily_prices p
          WHERE p.symbol = s.symbol AND p.exchange = s.exchange) >= 130
  ORDER BY s.symbol
  LIMIT GREATEST(1, LEAST(_limit, 200))
$$;

REVOKE ALL ON FUNCTION public.market_score_backfill_candidates(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_score_backfill_candidates(integer, integer) TO service_role;