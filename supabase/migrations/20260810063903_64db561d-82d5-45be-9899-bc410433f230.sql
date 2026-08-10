ALTER TABLE public.market_positions ADD COLUMN IF NOT EXISTS product text;

ALTER TABLE public.market_positions DROP CONSTRAINT IF EXISTS market_positions_product_chk;
ALTER TABLE public.market_positions ADD CONSTRAINT market_positions_product_chk
  CHECK (product IS NULL OR product IN ('MIS','CNC','NRML'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_market_positions_broker_unique
  ON public.market_positions (user_id, exchange, symbol, side)
  WHERE is_broker_synced AND closed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_market_holdings_broker_unique
  ON public.market_holdings (user_id, exchange, symbol)
  WHERE source = 'kotak_sync';