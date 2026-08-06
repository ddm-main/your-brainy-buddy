ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS penny_excluded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS penny_reason text,
  ADD COLUMN IF NOT EXISTS penny_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS market_stocks_penny_excluded_idx
  ON public.market_stocks (penny_excluded)
  WHERE penny_excluded;