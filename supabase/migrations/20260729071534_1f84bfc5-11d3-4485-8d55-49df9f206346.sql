
ALTER TABLE public.market_intraday_prices
  ADD COLUMN IF NOT EXISTS timeframe text NOT NULL DEFAULT '5m',
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS fetched_at timestamptz NOT NULL DEFAULT now();

-- Replace the (symbol,exchange,ts) unique key with one that includes timeframe
-- so 1m/5m/15m bars for the same instant don't collide.
ALTER TABLE public.market_intraday_prices
  DROP CONSTRAINT IF EXISTS market_intraday_prices_symbol_exchange_ts_key;

CREATE UNIQUE INDEX IF NOT EXISTS market_intraday_prices_sym_ex_tf_ts_key
  ON public.market_intraday_prices (symbol, exchange, timeframe, ts);

CREATE INDEX IF NOT EXISTS idx_market_intraday_sym_ex_tf_ts_desc
  ON public.market_intraday_prices (symbol, exchange, timeframe, ts DESC);

-- Widen grants: edge functions (service_role) write, authenticated users read
-- their own charts. Anonymous access stays denied.
GRANT SELECT ON public.market_intraday_prices TO authenticated;
GRANT ALL    ON public.market_intraday_prices TO service_role;

-- Per-user opt-in for delayed intraday fallback when Kotak is down.
ALTER TABLE public.market_user_prefs
  ADD COLUMN IF NOT EXISTS allow_delayed_intraday boolean NOT NULL DEFAULT false;
