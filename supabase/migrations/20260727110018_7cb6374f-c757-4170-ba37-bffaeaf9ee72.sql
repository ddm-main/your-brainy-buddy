ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS pivot_level numeric,
  ADD COLUMN IF NOT EXISTS pivot_touches integer,
  ADD COLUMN IF NOT EXISTS vol_dryup_ratio numeric;