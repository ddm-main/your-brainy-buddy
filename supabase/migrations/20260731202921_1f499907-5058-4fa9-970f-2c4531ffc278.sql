REVOKE EXECUTE ON FUNCTION public.score_history_coverage(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.market_score_cohort(text, integer, numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.market_score_cohort(text, integer, numeric, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.market_score_cohort_symbols(text, integer, numeric, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.market_score_cohort_symbols(text, integer, numeric, integer, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.score_history_coverage(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.market_score_cohort(text, integer, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.market_score_cohort(text, integer, numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.market_score_cohort_symbols(text, integer, numeric, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.market_score_cohort_symbols(text, integer, numeric, integer, text) TO authenticated, service_role;