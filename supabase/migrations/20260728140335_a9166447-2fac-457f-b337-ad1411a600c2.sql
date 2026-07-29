ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS breakout_rank_pct numeric,
  ADD COLUMN IF NOT EXISTS swing_rank_pct numeric;

CREATE INDEX IF NOT EXISTS idx_market_stock_scores_breakout_rank
  ON public.market_stock_scores (breakout_rank_pct DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_market_stock_scores_swing_rank
  ON public.market_stock_scores (swing_rank_pct DESC NULLS LAST);

NOTIFY pgrst, 'reload schema';