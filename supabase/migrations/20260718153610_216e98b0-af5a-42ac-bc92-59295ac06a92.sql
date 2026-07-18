ALTER TABLE public.market_stocks ADD COLUMN IF NOT EXISTS last_fundamentals_sync_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_market_stocks_fund_cursor
  ON public.market_stocks (last_fundamentals_sync_at NULLS FIRST)
  WHERE is_active AND in_universe;