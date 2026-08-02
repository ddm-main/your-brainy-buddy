REVOKE ALL ON FUNCTION public.market_rescore_prices_batch(date, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.market_rescore_prices_batch(date, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.market_rescore_prices_batch(date, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.market_rescore_prices_batch(date, integer, text) TO service_role;