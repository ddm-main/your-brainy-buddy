ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS shoonya_token text;

CREATE INDEX IF NOT EXISTS idx_market_stocks_shoonya_token
  ON public.market_stocks (shoonya_token) WHERE shoonya_token IS NOT NULL;

ALTER TABLE public.market_api_settings
  ADD COLUMN IF NOT EXISTS vendor_code text,
  ADD COLUMN IF NOT EXISTS api_secret_enc text,
  ADD COLUMN IF NOT EXISTS imei text;

ALTER TYPE public.market_holding_source ADD VALUE IF NOT EXISTS 'shoonya_sync';