
ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS rolling_high_20 numeric,
  ADD COLUMN IF NOT EXISTS rolling_high_20_date date,
  ADD COLUMN IF NOT EXISTS rolling_high_55 numeric,
  ADD COLUMN IF NOT EXISTS rolling_high_55_date date,
  ADD COLUMN IF NOT EXISTS obv_slope_20 numeric;

WITH ranked AS (
  SELECT symbol, exchange, trade_date, high,
    ROW_NUMBER() OVER (PARTITION BY symbol, exchange ORDER BY trade_date DESC) AS rn
  FROM public.market_daily_prices
),
h20 AS (
  SELECT DISTINCT ON (symbol, exchange) symbol, exchange, high AS hi, trade_date AS d
  FROM ranked WHERE rn <= 20
  ORDER BY symbol, exchange, high DESC, trade_date DESC
),
h55 AS (
  SELECT DISTINCT ON (symbol, exchange) symbol, exchange, high AS hi, trade_date AS d
  FROM ranked WHERE rn <= 55
  ORDER BY symbol, exchange, high DESC, trade_date DESC
)
UPDATE public.market_stock_scores s
   SET rolling_high_20 = h20.hi,
       rolling_high_20_date = h20.d,
       rolling_high_55 = h55.hi,
       rolling_high_55_date = h55.d
  FROM h20
  LEFT JOIN h55 ON h55.symbol = h20.symbol AND h55.exchange = h20.exchange
 WHERE s.symbol = h20.symbol AND s.exchange = h20.exchange;
