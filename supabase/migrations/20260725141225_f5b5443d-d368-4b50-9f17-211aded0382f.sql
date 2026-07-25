-- P0-12: dedupe market_stock_ai to one row per (user, symbol, exchange) so market-stock-insight can upsert instead of unbounded inserts.
-- Keep the newest row per key, drop the rest, then add the unique index.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY user_id, symbol, exchange
    ORDER BY computed_at DESC NULLS LAST, ctid DESC
  ) AS rn
  FROM public.market_stock_ai
)
DELETE FROM public.market_stock_ai a USING ranked r
 WHERE a.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS market_stock_ai_user_symbol_uidx
  ON public.market_stock_ai (user_id, symbol, exchange);
