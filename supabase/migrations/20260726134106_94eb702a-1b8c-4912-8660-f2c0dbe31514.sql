REVOKE EXECUTE ON FUNCTION public.market_asof_candles(date, text[], integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.market_history_backfill_candidates(integer, integer) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_asof_candles(date, text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.market_history_backfill_candidates(integer, integer) TO service_role;