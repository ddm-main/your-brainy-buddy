-- 1. market_news: add the symbol/exchange the app has always assumed exists
ALTER TABLE public.market_news
  ADD COLUMN IF NOT EXISTS symbol text,
  ADD COLUMN IF NOT EXISTS exchange text NOT NULL DEFAULT 'NSE';

CREATE UNIQUE INDEX IF NOT EXISTS market_news_symbol_exchange_url_key
  ON public.market_news (symbol, exchange, url);
CREATE INDEX IF NOT EXISTS market_news_symbol_published_idx
  ON public.market_news (symbol, exchange, published_at DESC);

GRANT SELECT ON public.market_news TO authenticated;
GRANT ALL ON public.market_news TO service_role;

-- 2. market_fundamentals_global: beta so the fallback path can render it
ALTER TABLE public.market_fundamentals_global
  ADD COLUMN IF NOT EXISTS beta numeric;

-- 3. corporate_actions: readable by signed-in users (Analysis panel reads it directly)
GRANT SELECT ON public.corporate_actions TO authenticated;
GRANT ALL ON public.corporate_actions TO service_role;