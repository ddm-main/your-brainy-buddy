
ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS price_sync_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_sync_attempts_day date;

ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS volume_nse bigint,
  ADD COLUMN IF NOT EXISTS volume_bse bigint;
