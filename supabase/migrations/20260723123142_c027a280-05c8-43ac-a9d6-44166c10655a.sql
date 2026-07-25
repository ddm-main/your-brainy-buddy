WITH ranked AS (
  SELECT
    p.symbol,
    p.exchange,
    p.volume::numeric AS volume,
    row_number() OVER (
      PARTITION BY p.symbol, p.exchange
      ORDER BY p.trade_date DESC
    ) AS rn
  FROM public.market_daily_prices p
  JOIN public.market_stock_scores sc
    ON sc.symbol = p.symbol
   AND sc.exchange = p.exchange
  WHERE p.volume IS NOT NULL
    AND p.volume > 0
    AND p.trade_date <= sc.trade_date
), baselines AS (
  SELECT
    symbol,
    exchange,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY volume) AS vol_typical30
  FROM ranked
  WHERE rn <= 30
  GROUP BY symbol, exchange
  HAVING count(*) >= 20
)
UPDATE public.market_stock_scores sc
SET vol_avg30 = b.vol_typical30,
    computed_at = COALESCE(sc.computed_at, now())
FROM baselines b
WHERE sc.symbol = b.symbol
  AND sc.exchange = b.exchange;

NOTIFY pgrst, 'reload schema';