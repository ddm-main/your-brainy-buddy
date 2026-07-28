CREATE OR REPLACE FUNCTION public.market_rescore_latest_from_prices(_trade_date date DEFAULT NULL::date, _limit integer DEFAULT 3000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_date date;
  n integer;
BEGIN
  SELECT COALESCE(_trade_date, max(trade_date))
  INTO target_date
  FROM public.market_daily_prices
  WHERE exchange = 'NSE';

  IF target_date IS NULL THEN
    RETURN 0;
  END IF;

  WITH candidates AS (
    SELECT s.symbol, s.exchange, s.sector
    FROM public.market_stocks s
    WHERE s.is_active = true
      AND s.exchange = 'NSE'
      AND EXISTS (
        SELECT 1
        FROM public.market_daily_prices p
        WHERE p.symbol = s.symbol
          AND p.exchange = s.exchange
          AND p.trade_date = target_date
      )
    ORDER BY s.symbol
    LIMIT GREATEST(1, LEAST(COALESCE(_limit, 3000), 5000))
  ), series AS (
    SELECT
      c.symbol,
      c.exchange,
      c.sector,
      p.trade_date,
      p.open,
      p.high,
      p.low,
      p.close,
      p.volume,
      row_number() OVER (PARTITION BY c.symbol, c.exchange ORDER BY p.trade_date DESC) AS rn_desc
    FROM candidates c
    JOIN public.market_daily_prices p
      ON p.symbol = c.symbol
     AND p.exchange = c.exchange
     AND p.trade_date <= target_date
  ), windowed AS (
    SELECT *
    FROM series
    WHERE rn_desc <= 260
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
    SELECT *
    FROM calc
    WHERE trade_date = target_date
      AND close IS NOT NULL
  )
  INSERT INTO public.market_stock_scores (
    symbol,
    exchange,
    trade_date,
    close,
    change_pct,
    change_pct_adjusted,
    volume,
    volume_nse,
    volume_bse,
    vol_avg20,
    vol_avg30,
    rel_volume,
    ema20,
    ema50,
    ema100,
    ema200,
    high_52w,
    low_52w,
    pct_from_52w_high,
    above_ema200,
    sector,
    breakout_score,
    prebreakout_score,
    score_components,
    context_complete,
    ret_5d,
    ret_21d,
    ret_ytd,
    computed_at
  )
  SELECT
    symbol,
    exchange,
    trade_date,
    close,
    CASE WHEN prev_close IS NOT NULL AND prev_close > 0 THEN round(((close - prev_close) / prev_close) * 100, 2) ELSE NULL END,
    CASE WHEN prev_close IS NOT NULL AND prev_close > 0 THEN round(((close - prev_close) / prev_close) * 100, 2) ELSE NULL END,
    volume,
    volume,
    NULL,
    vol_avg20,
    vol_avg30,
    CASE WHEN vol_avg30 IS NOT NULL AND vol_avg30 > 0 THEN round((volume::numeric / vol_avg30), 2) ELSE NULL END,
    sma20,
    sma50,
    sma100,
    sma200,
    high_52w,
    low_52w,
    CASE WHEN high_52w IS NOT NULL AND high_52w > 0 THEN round(((close - high_52w) / high_52w) * 100, 2) ELSE NULL END,
    CASE WHEN sma200 IS NOT NULL THEN close > sma200 ELSE NULL END,
    sector,
    LEAST(100, GREATEST(0,
      (CASE WHEN sma20 IS NOT NULL AND sma50 IS NOT NULL AND close > sma20 AND sma20 > sma50 THEN 18 ELSE 0 END) +
      (CASE WHEN sma50 IS NOT NULL AND sma200 IS NOT NULL AND close > sma50 AND sma50 > sma200 THEN 18 ELSE 0 END) +
      (CASE WHEN high_52w IS NOT NULL AND high_52w > 0 AND close >= high_52w * 0.95 THEN 18 ELSE 0 END) +
      (CASE WHEN vol_avg30 IS NOT NULL AND vol_avg30 > 0 AND volume::numeric >= vol_avg30 * 1.5 THEN 16 ELSE 0 END) +
      (CASE WHEN prev_close IS NOT NULL AND prev_close > 0 AND close > prev_close THEN 10 ELSE 0 END)
    )),
    LEAST(100, GREATEST(0,
      (CASE WHEN sma20 IS NOT NULL AND sma50 IS NOT NULL AND close > sma20 AND sma20 > sma50 THEN 20 ELSE 0 END) +
      (CASE WHEN high_52w IS NOT NULL AND high_52w > 0 AND close BETWEEN high_52w * 0.85 AND high_52w * 0.98 THEN 22 ELSE 0 END) +
      (CASE WHEN vol_avg30 IS NOT NULL AND vol_avg30 > 0 AND volume::numeric < vol_avg30 THEN 12 ELSE 0 END) +
      (CASE WHEN sma200 IS NOT NULL AND close > sma200 THEN 12 ELSE 0 END)
    )),
    jsonb_build_object('source', 'market_rescore_latest_from_prices', 'trade_date', target_date),
    false,
    CASE WHEN close_5d IS NOT NULL AND close_5d > 0 THEN round(((close - close_5d) / close_5d) * 100, 2) ELSE NULL END,
    CASE WHEN close_21d IS NOT NULL AND close_21d > 0 THEN round(((close - close_21d) / close_21d) * 100, 2) ELSE NULL END,
    CASE WHEN ytd_first_close IS NOT NULL AND ytd_first_close > 0 THEN round(((close - ytd_first_close) / ytd_first_close) * 100, 2) ELSE NULL END,
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
    volume_bse = EXCLUDED.volume_bse,
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
    breakout_score = EXCLUDED.breakout_score,
    prebreakout_score = EXCLUDED.prebreakout_score,
    score_components = EXCLUDED.score_components,
    context_complete = EXCLUDED.context_complete,
    ret_5d = EXCLUDED.ret_5d,
    ret_21d = EXCLUDED.ret_21d,
    ret_ytd = EXCLUDED.ret_ytd,
    computed_at = EXCLUDED.computed_at;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.market_rescore_latest_from_prices(date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_rescore_latest_from_prices(date, integer) TO service_role;