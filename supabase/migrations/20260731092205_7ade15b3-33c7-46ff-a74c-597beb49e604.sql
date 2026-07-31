ALTER TABLE public.market_intraday_prices
  ADD COLUMN IF NOT EXISTS cum_volume numeric;