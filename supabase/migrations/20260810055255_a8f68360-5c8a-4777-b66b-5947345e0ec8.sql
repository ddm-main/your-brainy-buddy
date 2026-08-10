CREATE OR REPLACE FUNCTION public.market_live_settled_anchors_lean(_symbols text[], _before date)
 RETURNS TABLE(symbol text, prev_close numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT ON (p.symbol)
    p.symbol, round(p.close, 2)
  FROM public.market_daily_prices p
  WHERE p.symbol = ANY(_symbols)
    AND p.exchange = 'NSE'
    AND p.trade_date < _before
    AND p.close IS NOT NULL
    AND p.close > 0
  ORDER BY p.symbol, p.trade_date DESC
$function$;

REVOKE ALL ON FUNCTION public.market_live_settled_anchors_lean(text[], date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_live_settled_anchors_lean(text[], date) TO service_role;