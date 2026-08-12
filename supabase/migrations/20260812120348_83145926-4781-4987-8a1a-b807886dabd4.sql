CREATE OR REPLACE FUNCTION public.refresh_market_screener_snapshot()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n integer;
BEGIN
  DELETE FROM public.market_screener_snapshot WHERE true;

  INSERT INTO public.market_screener_snapshot
  SELECT l.*, now()
  FROM public.market_screener_live l
  JOIN public.market_stocks s
    ON s.symbol = l.symbol AND s.exchange = l.exchange
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND s.instrument_type = 'EQ'
    AND coalesce(s.series, 'EQ') NOT IN ('SM','ST')
    AND coalesce(s.penny_excluded, false) = false;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;