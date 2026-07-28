
CREATE OR REPLACE FUNCTION public.market_archive_candidates(
  _limit integer DEFAULT 40,
  _hot_tracked integer DEFAULT 730,
  _hot_other integer DEFAULT 400
)
RETURNS TABLE(symbol text, exchange text, cutoff date, cold_bars integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH tracked AS (
    SELECT DISTINCT s FROM (
      SELECT symbol s FROM public.market_watchlist_items
      UNION SELECT symbol FROM public.market_holdings
      UNION SELECT symbol FROM public.market_positions
      UNION SELECT symbol FROM public.market_index_members
    ) x
  )
  SELECT p.symbol,
         p.exchange,
         (current_date - CASE WHEN t.s IS NOT NULL
                              THEN GREATEST(365, _hot_tracked)
                              ELSE GREATEST(200, _hot_other) END)::date AS cutoff,
         COUNT(*)::int AS cold_bars
  FROM public.market_daily_prices p
  LEFT JOIN tracked t ON t.s = p.symbol
  WHERE p.trade_date < current_date - CASE WHEN t.s IS NOT NULL
                                           THEN GREATEST(365, _hot_tracked)
                                           ELSE GREATEST(200, _hot_other) END
  GROUP BY p.symbol, p.exchange, t.s
  HAVING COUNT(*) >= 20
  ORDER BY COUNT(*) DESC
  LIMIT GREATEST(1, LEAST(_limit, 200))
$$;

REVOKE EXECUTE ON FUNCTION public.market_archive_candidates(integer, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.market_archive_candidates(integer, integer, integer) TO service_role;
