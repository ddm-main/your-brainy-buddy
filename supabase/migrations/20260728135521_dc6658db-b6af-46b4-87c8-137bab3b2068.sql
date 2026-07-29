ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS is_liquid_tradable boolean,
  ADD COLUMN IF NOT EXISTS liquidity_reasons jsonb,
  ADD COLUMN IF NOT EXISTS weekly_close numeric,
  ADD COLUMN IF NOT EXISTS weekly_ema20 numeric,
  ADD COLUMN IF NOT EXISTS weekly_rsi14 numeric,
  ADD COLUMN IF NOT EXISTS weekly_trend_up boolean,
  ADD COLUMN IF NOT EXISTS weekly_higher_lows boolean;

CREATE INDEX IF NOT EXISTS market_stock_scores_liquid_idx
  ON public.market_stock_scores (is_liquid_tradable)
  WHERE is_liquid_tradable;

NOTIFY pgrst, 'reload schema';