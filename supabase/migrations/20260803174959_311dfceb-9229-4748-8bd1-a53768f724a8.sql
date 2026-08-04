ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS breakout_state_days integer,
  ADD COLUMN IF NOT EXISTS ema_cross_20_50_days integer,
  ADD COLUMN IF NOT EXISTS ema_cross_50_200_days integer,
  ADD COLUMN IF NOT EXISTS vol_dryup_ratio_base numeric,
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

COMMENT ON COLUMN public.market_stock_scores.breakout_state_days IS
  'Sessions since the current breakout state began; zero means the current session.';
COMMENT ON COLUMN public.market_stock_scores.ema_cross_20_50_days IS
  'Sessions since EMA20 crossed above EMA50; -1 means currently below and null means unknown.';
COMMENT ON COLUMN public.market_stock_scores.ema_cross_50_200_days IS
  'Sessions since EMA50 crossed above EMA200; -1 means currently below and null means unknown.';
COMMENT ON COLUMN public.market_stock_scores.vol_dryup_ratio_base IS
  'Five-session versus twenty-session average volume ratio measured on the pre-breakout base.';

CREATE OR REPLACE FUNCTION public.promote_market_eod_session(_trade_date date DEFAULT NULL)
RETURNS TABLE(
  session_date date,
  source_rows integer,
  eligible_rows integer,
  promoted_rows integer,
  skipped_rows integer,
  remaining_gap integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '240s'
AS $function$
DECLARE
  target_date date;
  source_n integer := 0;
  eligible_n integer := 0;
  promoted_n integer := 0;
  remaining_n integer := 0;
BEGIN
  SELECT COALESCE(_trade_date, max(e.trade_date))
    INTO target_date
  FROM public.market_eod_nse e
  WHERE e.exchange = 'NSE';

  IF target_date IS NULL THEN
    RETURN QUERY SELECT NULL::date, 0, 0, 0, 0, 0;
    RETURN;
  END IF;

  SELECT count(*)::integer
    INTO source_n
  FROM public.market_eod_nse e
  WHERE e.exchange = 'NSE'
    AND e.trade_date = target_date;

  SELECT count(*)::integer
    INTO eligible_n
  FROM public.market_eod_nse e
  JOIN public.market_stocks s
    ON s.symbol = e.symbol
   AND s.exchange = e.exchange
   AND s.is_active = true
  WHERE e.exchange = 'NSE'
    AND e.trade_date = target_date
    AND e.close IS NOT NULL
    AND e.close > 0;

  INSERT INTO public.market_daily_prices (
    symbol, exchange, trade_date, open, high, low, close, volume
  )
  SELECT
    e.symbol,
    e.exchange,
    e.trade_date,
    e.open,
    e.high,
    e.low,
    e.close,
    e.volume
  FROM public.market_eod_nse e
  JOIN public.market_stocks s
    ON s.symbol = e.symbol
   AND s.exchange = e.exchange
   AND s.is_active = true
  WHERE e.exchange = 'NSE'
    AND e.trade_date = target_date
    AND e.close IS NOT NULL
    AND e.close > 0
  ON CONFLICT (symbol, exchange, trade_date)
  DO UPDATE SET
    open = EXCLUDED.open,
    high = EXCLUDED.high,
    low = EXCLUDED.low,
    close = EXCLUDED.close,
    volume = EXCLUDED.volume;

  GET DIAGNOSTICS promoted_n = ROW_COUNT;

  SELECT count(*)::integer
    INTO remaining_n
  FROM public.market_eod_nse e
  JOIN public.market_stocks s
    ON s.symbol = e.symbol
   AND s.exchange = e.exchange
   AND s.is_active = true
  WHERE e.exchange = 'NSE'
    AND e.trade_date = target_date
    AND e.close IS NOT NULL
    AND e.close > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.market_daily_prices p
      WHERE p.symbol = e.symbol
        AND p.exchange = e.exchange
        AND p.trade_date = e.trade_date
    );

  RETURN QUERY SELECT
    target_date,
    source_n,
    eligible_n,
    promoted_n,
    GREATEST(source_n - eligible_n, 0),
    remaining_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.promote_market_eod_session(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promote_market_eod_session(date) FROM anon;
REVOKE ALL ON FUNCTION public.promote_market_eod_session(date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_market_eod_session(date) TO service_role;

NOTIFY pgrst, 'reload schema';