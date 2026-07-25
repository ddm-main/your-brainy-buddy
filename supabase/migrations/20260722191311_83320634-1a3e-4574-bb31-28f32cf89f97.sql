ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS tickertape_sid text,
  ADD COLUMN IF NOT EXISTS tickertape_sid_as_of timestamptz;

CREATE INDEX IF NOT EXISTS idx_market_stocks_tickertape_sid ON public.market_stocks (tickertape_sid) WHERE tickertape_sid IS NOT NULL;