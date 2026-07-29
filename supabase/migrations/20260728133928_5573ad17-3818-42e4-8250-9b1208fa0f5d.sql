ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS swing_score numeric,
  ADD COLUMN IF NOT EXISTS swing_components jsonb,
  ADD COLUMN IF NOT EXISTS intraday_score numeric,
  ADD COLUMN IF NOT EXISTS intraday_components jsonb;

CREATE INDEX IF NOT EXISTS market_stock_scores_swing_score_idx
  ON public.market_stock_scores (swing_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS market_stock_scores_intraday_score_idx
  ON public.market_stock_scores (intraday_score DESC NULLS LAST);

NOTIFY pgrst, 'reload schema';