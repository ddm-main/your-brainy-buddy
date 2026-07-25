-- Phase 1: complete v2 scoring pipeline columns on market_stock_scores.
-- Existing: base_tightness, base_depth_pct. Adding the rest as nullable so
-- scoring degrades gracefully until the pipeline backfills them.
ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS obv_slope20 numeric,
  ADD COLUMN IF NOT EXISTS base_duration_days integer,
  ADD COLUMN IF NOT EXISTS rs_percentile numeric,
  ADD COLUMN IF NOT EXISTS close_in_range_pct numeric,
  ADD COLUMN IF NOT EXISTS breakout_freshness_days integer;

COMMENT ON COLUMN public.market_stock_scores.obv_slope20 IS 'Linear slope of OBV over last 20 sessions, normalized. Positive = accumulation.';
COMMENT ON COLUMN public.market_stock_scores.base_duration_days IS 'Trading days the price has spent in the current consolidation base.';
COMMENT ON COLUMN public.market_stock_scores.rs_percentile IS 'Relative-strength percentile vs Nifty 500 (0..100).';
COMMENT ON COLUMN public.market_stock_scores.close_in_range_pct IS 'Where today closed within the daily range (0..100). 100 = at high.';
COMMENT ON COLUMN public.market_stock_scores.breakout_freshness_days IS 'Sessions since the rolling-20d high was first cleared. 0 = today.';