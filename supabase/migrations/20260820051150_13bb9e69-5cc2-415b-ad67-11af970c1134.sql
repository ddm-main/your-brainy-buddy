CREATE OR REPLACE FUNCTION public.market_valid_prior_volume_avg(
  _symbol text,
  _exchange text,
  _before date,
  _sessions integer DEFAULT 30
)
RETURNS TABLE(avg_volume numeric, session_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT avg(v.volume)::numeric, count(*)::integer
  FROM (
    SELECT p.trade_date, max(p.volume)::numeric AS volume
    FROM public.market_daily_prices p
    WHERE p.symbol = _symbol
      AND p.exchange = _exchange
      AND p.trade_date < _before
      AND extract(isodow FROM p.trade_date) BETWEEN 1 AND 5
      AND p.volume > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.market_holidays h
        WHERE h.exchange = _exchange AND h.holiday_date = p.trade_date
      )
    GROUP BY p.trade_date
    ORDER BY p.trade_date DESC
    LIMIT LEAST(GREATEST(COALESCE(_sessions, 30), 1), 60)
  ) v
$$;

REVOKE ALL ON FUNCTION public.market_valid_prior_volume_avg(text,text,date,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_valid_prior_volume_avg(text,text,date,integer) TO service_role;

WITH repaired AS (
  SELECT s.symbol, s.exchange, v.avg_volume, v.session_count
  FROM public.market_stock_scores s
  CROSS JOIN LATERAL public.market_valid_prior_volume_avg(s.symbol, s.exchange, s.trade_date, 30) v
  WHERE s.exchange = 'NSE'
)
UPDATE public.market_stock_scores s
SET vol_avg30 = CASE WHEN r.session_count = 30 THEN r.avg_volume ELSE NULL END,
    rel_volume = CASE
      WHEN r.session_count = 30 AND r.avg_volume > 0 AND s.volume IS NOT NULL
      THEN round(s.volume::numeric / r.avg_volume, 2)
      ELSE NULL
    END
FROM repaired r
WHERE s.symbol = r.symbol AND s.exchange = r.exchange;

CREATE OR REPLACE FUNCTION public.market_rescore_prices_batch(_trade_date date DEFAULT NULL, _limit integer DEFAULT 400, _after_symbol text DEFAULT NULL)
RETURNS TABLE(processed integer, last_symbol text, session_date date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '240s'
AS $$
#variable_conflict use_column
DECLARE
  target_date date;
  batch_size integer := GREATEST(1, LEAST(COALESCE(_limit, 400), 1000));
  syms text[];
BEGIN
  SELECT COALESCE(_trade_date, max(p.trade_date)) INTO target_date
  FROM public.market_daily_prices p
  WHERE p.exchange = 'NSE'
    AND p.volume > 0
    AND extract(isodow FROM p.trade_date) BETWEEN 1 AND 5
    AND NOT EXISTS (
      SELECT 1 FROM public.market_holidays h
      WHERE h.exchange = p.exchange AND h.holiday_date = p.trade_date
    );

  IF target_date IS NULL THEN
    RETURN QUERY SELECT 0, NULL::text, NULL::date;
    RETURN;
  END IF;

  SELECT array_agg(c.symbol ORDER BY c.symbol) INTO syms
  FROM (
    SELECT s.symbol
    FROM public.market_stocks s
    WHERE s.is_active = true
      AND s.in_universe = true
      AND s.instrument_type = 'EQ'
      AND s.exchange = 'NSE'
      AND (_after_symbol IS NULL OR s.symbol > _after_symbol)
      AND EXISTS (
        SELECT 1 FROM public.market_daily_prices p
        WHERE p.symbol = s.symbol AND p.exchange = s.exchange
          AND p.trade_date = target_date AND p.volume > 0
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
    SELECT c.symbol, c.exchange, c.sector,
      p.trade_date, p.open, p.high, p.low, p.close, p.volume, p.delivery_pct,
      row_number() OVER (PARTITION BY c.symbol, c.exchange ORDER BY p.trade_date DESC) AS rn_desc
    FROM candidates c
    JOIN public.market_daily_prices p ON p.symbol = c.symbol AND p.exchange = c.exchange
    WHERE p.trade_date <= target_date
      AND p.volume > 0
      AND extract(isodow FROM p.trade_date) BETWEEN 1 AND 5
      AND NOT EXISTS (
        SELECT 1 FROM public.market_holidays h
        WHERE h.exchange = p.exchange AND h.holiday_date = p.trade_date
      )
  ), windowed AS (
    SELECT * FROM series WHERE rn_desc <= 260
  ), calc AS (
    SELECT w.*,
      public.ema_agg(close, (2.0/21)::numeric) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ema20,
      public.ema_agg(close, (2.0/51)::numeric) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ema50,
      public.ema_agg(close, (2.0/101)::numeric) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ema100,
      public.ema_agg(close, (2.0/201)::numeric) OVER (PARTITION BY symbol, exchange ORDER BY trade_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ema200,
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
  SELECT symbol, exchange, trade_date, close,
    CASE WHEN prev_close > 0 THEN round(((close-prev_close)/prev_close)*100,2) END,
    CASE WHEN prev_close > 0 THEN round(((close-prev_close)/prev_close)*100,2) END,
    volume, volume, NULL, vol_avg20, vol_avg30,
    CASE WHEN vol_avg30 > 0 THEN round(volume::numeric/vol_avg30,2) END,
    round(ema20,4), round(ema50,4), round(ema100,4), round(ema200,4), high_52w, low_52w,
    CASE WHEN high_52w > 0 THEN round(((close-high_52w)/high_52w)*100,2) END,
    CASE WHEN ema200 IS NOT NULL THEN close > ema200 END,
    sector, delivery_pct,
    CASE WHEN close_5d > 0 THEN round(((close-close_5d)/close_5d)*100,2) END,
    CASE WHEN close_21d > 0 THEN round(((close-close_21d)/close_21d)*100,2) END,
    CASE WHEN ytd_first_close > 0 THEN round(((close-ytd_first_close)/ytd_first_close)*100,2) END,
    false, now()
  FROM latest
  ON CONFLICT (symbol, exchange) DO UPDATE SET
    trade_date=EXCLUDED.trade_date, close=EXCLUDED.close,
    change_pct=EXCLUDED.change_pct, change_pct_adjusted=EXCLUDED.change_pct_adjusted,
    volume=EXCLUDED.volume, volume_nse=EXCLUDED.volume_nse,
    vol_avg20=EXCLUDED.vol_avg20, vol_avg30=EXCLUDED.vol_avg30, rel_volume=EXCLUDED.rel_volume,
    ema20=EXCLUDED.ema20, ema50=EXCLUDED.ema50, ema100=EXCLUDED.ema100, ema200=EXCLUDED.ema200,
    high_52w=EXCLUDED.high_52w, low_52w=EXCLUDED.low_52w,
    pct_from_52w_high=EXCLUDED.pct_from_52w_high, above_ema200=EXCLUDED.above_ema200,
    sector=EXCLUDED.sector,
    delivery_pct=COALESCE(EXCLUDED.delivery_pct, public.market_stock_scores.delivery_pct),
    ret_5d=EXCLUDED.ret_5d, ret_21d=EXCLUDED.ret_21d, ret_ytd=EXCLUDED.ret_ytd,
    is_stale=false, computed_at=EXCLUDED.computed_at,
    score_trade_date=CASE
      WHEN public.market_stock_scores.breakout_score_v4 IS NULL THEN NULL
      ELSE COALESCE(public.market_stock_scores.score_trade_date, public.market_stock_scores.trade_date)
    END;

  RETURN QUERY SELECT array_length(syms,1)::integer, syms[array_length(syms,1)]::text, target_date;
END;
$$;

DROP FUNCTION IF EXISTS public.market_screener_core_candidates(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean,integer,text);
CREATE FUNCTION public.market_screener_core_candidates(
  _min_price numeric DEFAULT NULL, _max_price numeric DEFAULT NULL,
  _min_market_cap numeric DEFAULT NULL, _max_market_cap numeric DEFAULT NULL,
  _min_change_pct numeric DEFAULT NULL, _max_change_pct numeric DEFAULT NULL,
  _min_volume numeric DEFAULT NULL, _max_volume numeric DEFAULT NULL,
  _volume_above_avg boolean DEFAULT NULL, _liquid_only boolean DEFAULT false,
  _limit integer DEFAULT 600, _after_symbol text DEFAULT NULL
)
RETURNS TABLE(
  symbol text, exchange text, company_name text, trade_date date,
  close numeric, previous_close numeric, change_abs numeric, change_pct numeric,
  change_pct_raw numeric, volume numeric, vol_avg30 numeric, market_cap numeric,
  mcap_basis text, breakout_score_v4 numeric, is_liquid_tradable boolean,
  live_provider text, live_as_of timestamptz, live_sweep_id uuid, quote_state text,
  snapshot_token text, snapshot_session date, universe_count bigint, candidate_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH promoted AS (
    SELECT r.sweep_id, r.session_date, r.as_of
    FROM public.market_live_price_runs r
    WHERE r.status='complete' AND r.completed_at IS NOT NULL
    ORDER BY r.completed_at DESC LIMIT 1
  ), universe AS (
    SELECT count(*)::bigint AS n FROM public.market_live_sweep_universe()
  ), matches AS (
    SELECT s.*, p.sweep_id AS fixed_sweep_id, p.session_date AS fixed_session,
      p.as_of AS fixed_as_of, u.n AS fixed_universe_count
    FROM public.market_screener_rows s CROSS JOIN promoted p CROSS JOIN universe u
    WHERE s.exchange='NSE' AND s.instrument_type='EQ'
      AND s.is_active=true AND s.in_universe=true
      AND s.quote_state='live' AND s.live_sweep_id=p.sweep_id
      AND (_min_price IS NULL OR s.close >= _min_price)
      AND (_max_price IS NULL OR s.close <= _max_price)
      AND (_min_market_cap IS NULL OR s.market_cap >= _min_market_cap)
      AND (_max_market_cap IS NULL OR s.market_cap <= _max_market_cap)
      AND (_min_change_pct IS NULL OR s.change_pct_raw >= _min_change_pct)
      AND (_max_change_pct IS NULL OR s.change_pct_raw <= _max_change_pct)
      AND (_min_volume IS NULL OR s.volume >= _min_volume)
      AND (_max_volume IS NULL OR s.volume <= _max_volume)
      AND (_volume_above_avg IS DISTINCT FROM true OR (s.vol_avg30 > 0 AND s.volume > s.vol_avg30))
      AND (_volume_above_avg IS DISTINCT FROM false OR NOT (s.vol_avg30 > 0 AND s.volume > s.vol_avg30))
      AND (NOT _liquid_only OR s.is_liquid_tradable IS NOT FALSE)
  ), counted AS (
    SELECT m.*, count(*) OVER ()::bigint AS fixed_candidate_count FROM matches m
  )
  SELECT c.symbol::text,c.exchange::text,c.company_name::text,c.trade_date::date,
    c.close::numeric,c.previous_close::numeric,c.change_abs::numeric,c.change_pct::numeric,
    c.change_pct_raw::numeric,c.volume::numeric,c.vol_avg30::numeric,c.market_cap::numeric,
    c.mcap_basis::text,c.breakout_score_v4::numeric,c.is_liquid_tradable::boolean,
    c.live_provider::text,c.fixed_as_of::timestamptz,c.fixed_sweep_id::uuid,c.quote_state::text,
    (c.fixed_sweep_id::text || '@' || extract(epoch FROM c.fixed_as_of)::bigint::text)::text,
    c.fixed_session::date,c.fixed_universe_count,c.fixed_candidate_count
  FROM counted c
  WHERE (_after_symbol IS NULL OR c.symbol > _after_symbol)
  ORDER BY c.symbol
  LIMIT LEAST(GREATEST(COALESCE(_limit,600),1),600)
$$;
REVOKE ALL ON FUNCTION public.market_screener_core_candidates(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.market_screener_core_candidates(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean,integer,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.market_screener_snapshot_diagnostic(
  _min_price numeric DEFAULT NULL, _max_price numeric DEFAULT NULL,
  _min_market_cap numeric DEFAULT NULL, _max_market_cap numeric DEFAULT NULL,
  _min_change_pct numeric DEFAULT NULL, _max_change_pct numeric DEFAULT NULL,
  _min_volume numeric DEFAULT NULL, _max_volume numeric DEFAULT NULL,
  _volume_above_avg boolean DEFAULT NULL, _liquid_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH promoted AS (
    SELECT r.sweep_id,r.session_date,r.as_of FROM public.market_live_price_runs r
    WHERE r.status='complete' AND r.completed_at IS NOT NULL
    ORDER BY r.completed_at DESC LIMIT 1
  ), classified AS (
    SELECT s.symbol,p.sweep_id,p.session_date,p.as_of,
      CASE
        WHEN s.quote_state <> 'live' OR s.live_sweep_id IS DISTINCT FROM p.sweep_id THEN 'stale_or_missing_quote'
        WHEN s.market_cap IS NULL THEN 'missing_market_cap'
        WHEN _min_market_cap IS NOT NULL AND s.market_cap < _min_market_cap THEN 'market_cap_below_min'
        WHEN _max_market_cap IS NOT NULL AND s.market_cap > _max_market_cap THEN 'market_cap_above_max'
        WHEN _min_price IS NOT NULL AND s.close < _min_price THEN 'price_below_min'
        WHEN _max_price IS NOT NULL AND s.close > _max_price THEN 'price_above_max'
        WHEN _min_change_pct IS NOT NULL AND s.change_pct_raw < _min_change_pct THEN 'return_below_min'
        WHEN _max_change_pct IS NOT NULL AND s.change_pct_raw > _max_change_pct THEN 'return_above_max'
        WHEN _min_volume IS NOT NULL AND s.volume < _min_volume THEN 'volume_below_min'
        WHEN _max_volume IS NOT NULL AND s.volume > _max_volume THEN 'volume_above_max'
        WHEN _volume_above_avg IS NOT NULL AND (s.vol_avg30 IS NULL OR s.vol_avg30 <= 0) THEN 'missing_30_session_average'
        WHEN _volume_above_avg IS TRUE AND NOT (s.volume > s.vol_avg30) THEN 'volume_not_above_average'
        WHEN _volume_above_avg IS FALSE AND (s.volume > s.vol_avg30) THEN 'volume_above_average'
        WHEN _liquid_only AND s.is_liquid_tradable IS FALSE THEN 'not_liquid'
        ELSE 'matched'
      END AS reason
    FROM public.market_screener_rows s CROSS JOIN promoted p
    WHERE s.exchange='NSE' AND s.instrument_type='EQ' AND s.is_active=true AND s.in_universe=true
  ), counts AS (
    SELECT reason,count(*)::int AS n FROM classified GROUP BY reason
  )
  SELECT jsonb_build_object(
    'snapshot_token', (SELECT sweep_id::text || '@' || extract(epoch FROM as_of)::bigint::text FROM promoted),
    'session_date', (SELECT session_date FROM promoted),
    'as_of', (SELECT as_of FROM promoted),
    'universe_count', (SELECT count(*) FROM classified),
    'matched_symbols', COALESCE((SELECT jsonb_agg(symbol ORDER BY symbol) FROM classified WHERE reason='matched'),'[]'::jsonb),
    'reason_counts', COALESCE((SELECT jsonb_object_agg(reason,n) FROM counts),'{}'::jsonb)
  )
$$;
REVOKE ALL ON FUNCTION public.market_screener_snapshot_diagnostic(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.market_screener_snapshot_diagnostic(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean) TO authenticated, service_role;

SELECT public.market_penny_sweep(1000,50);
SELECT public.refresh_market_screener_snapshot();
DELETE FROM public.market_sweep_snapshot;
