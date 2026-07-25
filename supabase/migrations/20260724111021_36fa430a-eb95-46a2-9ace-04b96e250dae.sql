DROP VIEW IF EXISTS public.market_pipeline_token_coverage;
CREATE VIEW public.market_pipeline_token_coverage
  WITH (security_invoker = true) AS
SELECT
  s.exchange,
  COUNT(*)::int                                                       AS total_active,
  COUNT(*) FILTER (WHERE s.token IS NOT NULL)::int                    AS with_token,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE s.token IS NOT NULL) / NULLIF(COUNT(*), 0),
    2
  )                                                                    AS coverage_pct
FROM public.market_stocks s
WHERE s.is_active
GROUP BY s.exchange;

GRANT SELECT ON public.market_pipeline_token_coverage TO authenticated, service_role;