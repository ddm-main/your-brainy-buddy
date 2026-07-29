REVOKE ALL ON FUNCTION public.evaluate_score_history_forward(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fit_score_calibration(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_score_distribution(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_score_history_forward(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fit_score_calibration(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_score_distribution(text) TO service_role;