
CREATE OR REPLACE VIEW public.market_pipeline_status
WITH (security_invoker=on) AS
SELECT
  (SELECT COUNT(*) FROM public.market_stocks WHERE is_active) AS active_stocks,
  (SELECT COUNT(*) FROM public.market_fundamentals_global WHERE sync_status IN ('ok','partial')) AS fundamentals_covered,
  (SELECT COUNT(*) FROM public.market_fundamentals_global WHERE sync_status = 'failed') AS fundamentals_failed,
  (SELECT MAX(updated_at) FROM public.market_fundamentals_global) AS fundamentals_last_updated_at,
  (SELECT MAX(trade_date) FROM public.market_stock_scores) AS scores_last_trade_date,
  (SELECT COUNT(*) FROM public.market_stock_scores WHERE trade_date = (SELECT MAX(trade_date) FROM public.market_stock_scores)) AS scores_last_count;

GRANT SELECT ON public.market_pipeline_status TO authenticated, anon;
