CREATE OR REPLACE FUNCTION public.market_live_settled_anchors(_symbols text[], _before date)
RETURNS TABLE(symbol text, exchange text, prev_close numeric, trade_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT DISTINCT ON (p.symbol, p.exchange)
    p.symbol, p.exchange, p.close, p.trade_date
  FROM public.market_daily_prices p
  WHERE p.symbol = ANY(_symbols)
    AND p.exchange = 'NSE'
    AND p.trade_date < _before
    AND p.close IS NOT NULL
    AND p.close > 0
  ORDER BY p.symbol, p.exchange, p.trade_date DESC
$$;
REVOKE ALL ON FUNCTION public.market_live_settled_anchors(text[],date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_live_settled_anchors(text[],date) TO service_role;