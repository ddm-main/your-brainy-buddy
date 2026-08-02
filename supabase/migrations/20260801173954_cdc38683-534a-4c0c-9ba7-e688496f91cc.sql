ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS support_fallback boolean,
  ADD COLUMN IF NOT EXISTS resistance_fallback boolean,
  ADD COLUMN IF NOT EXISTS resistance_above numeric,
  ADD COLUMN IF NOT EXISTS breakout_state text,
  ADD COLUMN IF NOT EXISTS breakout_level_cleared numeric,
  ADD COLUMN IF NOT EXISTS rolling_high_20_touches integer,
  ADD COLUMN IF NOT EXISTS rolling_high_20_touch_quality numeric,
  ADD COLUMN IF NOT EXISTS macd_hist_rising boolean,
  ADD COLUMN IF NOT EXISTS atr_contracting boolean,
  ADD COLUMN IF NOT EXISTS weekly_bars integer;

-- Batched, keyset-paginated rescore from stored daily prices.
-- Returns how many candidate symbols the batch covered and the cursor to pass
-- as _after_symbol for the next batch. Callers loop until processed = 0.
CREATE OR REPLACE FUNCTION public.market_rescore_prices_batch(
  _trade_date date DEFAULT NULL,
  _limit integer DEFAULT 400,
  _after_symbol text DEFAULT NULL
)
RETURNS TABLE(processed integer, last_symbol text, trade_date date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '240s'
AS $function$
DECLARE
  target_date date;
  batch_size integer := GREATEST(1, LEAST(COALESCE(_limit, 400), 1000));
  syms text[];
BEGIN
  SELECT COALESCE(_trade_date, max(p.trade_date))
  INTO target_date
  FROM public.market_daily_prices p
  WHERE p.exchange = 'NSE';

  IF target_date IS NULL THEN
    RETURN QUERY SELECT 0, NULL::text, NULL::date;
    RETURN;
  END IF;

  SELECT array_agg(c.symbol ORDER BY c.symbol) INTO syms
  FROM (
    SELECT s.symbol
    FROM public.market_stocks s
    WHERE s.is_active = true
      AND s.exchange = 'NSE'
      AND (_after_symbol IS NULL OR s.symbol > _after_symbol)
      AND EXISTS (
        SELECT 1 FROM public.market_daily_prices p
        WHERE p.symbol = s.symbol AND p.exchange = s.exchange AND p.trade_date = target_date
      )
    ORDER BY s.symbol
    LIMIT batch_size
  ) c;

  IF syms IS NULL OR array_length(syms, 1) IS NULL THEN
    RETURN QUERY SELECT 0, NULL::text, target_date;
    RETURN;
  END IF;

  WITH candidates AS (
    SELECT s.symbol, s.exchange, s.sector
    FROM public.market_stocks s
    WHERE s.exchange = 'NSE' AND s.symbol = ANY(syms)
  ), series AS (
    SELECT
      c.symbol, c.exchange, c.sector,
      p.trade_date, p.open, p.high, p.low, p.close, p.volume, p.delivery_pct,
      row_number() OVER (PARTITION BY c.symbol, c.exchange ORDER BY p.trade_date DESC) AS rn_desc
    FROM candidates c
    JOIN public.market_daily_prices p
      ON p.symbol = c.symbol AND p.exchange = c.exchange AND p.trade_date <= target_date
  ), windowed AS (
    SELECT * FROM series WHERE rn_desc <= 260
  ), calc AS (
    SELECT
      w.*,
      avg(close) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS sma20,
      avg(close) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN 49 PRECEDING AND CURRENT ROW) AS sma50,
      avg(close) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN 99 PRECEDING AND CURRENT ROW) AS sma100,
      avg(close) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN 199 PRECEDING AND CURRENT ROW) AS sma200,
      avg(volume) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS vol_avg20,
      avg(volume) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS vol_avg30,
      max(high) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN 251 PRECEDING AND CURRENT ROW) AS high_52w,
      min(low) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN 251 PRECEDING AND CURRENT ROW) AS low_52w,
      lag(close) OVER (PARTITION BY symbol, exchange ORDER BY trade_date) AS prev_close,
      lag(close, 5) OVER (PARTITION BY symbol, exchange ORDER BY trade_date) AS close_5d,
      lag(close, 21) OVER (PARTITION BY symbol, exchange ORDER BY trade_date) AS close_21d,
      first_value(close) OVER (PARTITION BY symbol, exchange, date_trunc('year', trade_date) ORDER BY trade_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS ytd_first_close
    FROM windowed w
  ), latest AS (
    SELECT * FROM calc WHERE trade_date = target_date AND close IS NOT NULL
  )
  INSERT INTO public.market_stock_scores (
    symbol, exchange, trade_date, close, change_pct, change_pct_adjusted,
    volume, volume_nse, volume_bse, vol_avg20, vol_avg30, rel_volume,
    ema20, ema50, ema100, ema200, high_52w, low_52w, pct_from_52w_high,
    above_ema200, sector, delivery_pct, ret_5d, ret_21d, ret_ytd, is_stale, computed_at
  )
  SELECT
    symbol, exchange, trade_date, close,
    CASE WHEN prev_close IS NOT NULL AND prev_close > 0 THEN round(((close - prev_close) / prev_close) * 100, 2) END,
    CASE WHEN prev_close IS NOT NULL AND prev_close > 0 THEN round(((close - prev_close) / prev_close) * 100, 2) END,
    volume, volume, NULL, vol_avg20, vol_avg30,
    CASE WHEN vol_avg30 IS NOT NULL AND vol_avg30 > 0 THEN round((volume::numeric / vol_avg30), 2) END,
    sma20, sma50, sma100, sma200, high_52w, low_52w,
    CASE WHEN high_52w IS NOT NULL AND high_52w > 0 THEN round(((close - high_52w) / high_52w) * 100, 2) END,
    CASE WHEN sma200 IS NOT NULL THEN close > sma200 END,
    sector,
    delivery_pct,
    CASE WHEN close_5d IS NOT NULL AND close_5d > 0 THEN round(((close - close_5d) / close_5d) * 100, 2) END,
    CASE WHEN close_21d IS NOT NULL AND close_21d > 0 THEN round(((close - close_21d) / close_21d) * 100, 2) END,
    CASE WHEN ytd_first_close IS NOT NULL AND ytd_first_close > 0 THEN round(((close - ytd_first_close) / ytd_first_close) * 100, 2) END,
    false,
    now()
  FROM latest
  ON CONFLICT (symbol, exchange)
  DO UPDATE SET
    trade_date = EXCLUDED.trade_date,
    close = EXCLUDED.close,
    change_pct = EXCLUDED.change_pct,
    change_pct_adjusted = EXCLUDED.change_pct_adjusted,
    volume = EXCLUDED.volume,
    volume_nse = EXCLUDED.volume_nse,
    vol_avg20 = EXCLUDED.vol_avg20,
    vol_avg30 = EXCLUDED.vol_avg30,
    rel_volume = EXCLUDED.rel_volume,
    ema20 = EXCLUDED.ema20,
    ema50 = EXCLUDED.ema50,
    ema100 = EXCLUDED.ema100,
    ema200 = EXCLUDED.ema200,
    high_52w = EXCLUDED.high_52w,
    low_52w = EXCLUDED.low_52w,
    pct_from_52w_high = EXCLUDED.pct_from_52w_high,
    above_ema200 = EXCLUDED.above_ema200,
    sector = EXCLUDED.sector,
    delivery_pct = COALESCE(EXCLUDED.delivery_pct, public.market_stock_scores.delivery_pct),
    ret_5d = EXCLUDED.ret_5d,
    ret_21d = EXCLUDED.ret_21d,
    ret_ytd = EXCLUDED.ret_ytd,
    is_stale = false,
    computed_at = EXCLUDED.computed_at;

  RETURN QUERY SELECT array_length(syms, 1)::integer, syms[array_length(syms, 1)]::text, target_date;
END;
$function$;

ALTER FUNCTION public.market_rescore_latest_from_prices(date, integer) SET statement_timeout TO '240s';

GRANT EXECUTE ON FUNCTION public.market_rescore_prices_batch(date, integer, text) TO service_role;