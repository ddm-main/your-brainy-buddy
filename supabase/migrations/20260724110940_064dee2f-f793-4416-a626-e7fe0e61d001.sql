-- Scoring v2 shadow columns on the real scoring table
ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS breakout_score_v2 numeric,
  ADD COLUMN IF NOT EXISTS score_components_v2 jsonb,
  ADD COLUMN IF NOT EXISTS base_depth_pct numeric,
  ADD COLUMN IF NOT EXISTS base_len_days integer;

CREATE INDEX IF NOT EXISTS idx_market_stock_scores_breakout_v2
  ON public.market_stock_scores (breakout_score_v2 DESC NULLS LAST);

-- Token coverage view for Market Config pipeline-health panel
CREATE OR REPLACE VIEW public.market_pipeline_token_coverage AS
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