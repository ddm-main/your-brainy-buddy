
-- Revoke API access to the raw MV; expose a plain view instead.
REVOKE SELECT ON public.market_top_movers_daily FROM anon;
REVOKE SELECT ON public.market_top_movers_daily FROM authenticated;

CREATE OR REPLACE VIEW public.market_top_movers
WITH (security_invoker = on) AS
SELECT symbol, exchange, sector, close, change_pct, volume, rel_volume,
       rsi14, breakout_score, trade_date, direction, rn
FROM public.market_top_movers_daily;

GRANT SELECT ON public.market_top_movers TO authenticated;
GRANT SELECT ON public.market_top_movers TO anon;

-- Restrict the refresh helper to backend/service-role only.
REVOKE EXECUTE ON FUNCTION public.refresh_market_top_movers() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refresh_market_top_movers() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_market_top_movers() FROM anon;
GRANT EXECUTE ON FUNCTION public.refresh_market_top_movers() TO service_role;
