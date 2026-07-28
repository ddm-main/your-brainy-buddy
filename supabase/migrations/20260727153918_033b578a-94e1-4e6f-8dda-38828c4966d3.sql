-- Backfill candidate selection by DENSITY, not raw bar count. The old
-- `range=max` Yahoo bug stored monthly bars in market_daily_prices, so a
-- corrupted symbol could clear a raw min_bars threshold while holding almost
-- no real daily history.
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
    SELECT p.symbol,
           p.exchange,
           COUNT(*)::int AS bars,
           GREATEST(1, (MAX(p.trade_date) - MIN(p.trade_date)) / 30.4375) AS months
    FROM public.market_daily_prices p
    GROUP BY p.symbol, p.exchange
  ) d ON d.symbol = s.symbol AND d.exchange = s.exchange
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND (
      COALESCE(d.bars, 0) < GREATEST(30, LEAST(_min_bars, 600))
      -- sparse / wrong-grain: real daily history is ~21 bars per month
      OR (d.bars IS NOT NULL AND d.bars / d.months < 12)
    )
  ORDER BY COALESCE(d.bars, 0) DESC, s.symbol ASC
  LIMIT GREATEST(1, LEAST(_limit, 200))
$$;

REVOKE ALL ON FUNCTION public.market_history_backfill_candidates(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_history_backfill_candidates(integer, integer) TO service_role;