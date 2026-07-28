REVOKE ALL ON public.market_screener_snapshot FROM anon, authenticated;

DROP VIEW public.market_screener_rows;
CREATE VIEW public.market_screener_rows AS
SELECT * FROM public.market_screener_snapshot;
GRANT SELECT ON public.market_screener_rows TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.refresh_market_screener_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_market_screener_snapshot() TO service_role;