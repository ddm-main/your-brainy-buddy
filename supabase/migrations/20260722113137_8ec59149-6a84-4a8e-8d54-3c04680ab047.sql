REVOKE EXECUTE ON FUNCTION public.purge_old_ticker_trace() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_ticker_trace() TO service_role;