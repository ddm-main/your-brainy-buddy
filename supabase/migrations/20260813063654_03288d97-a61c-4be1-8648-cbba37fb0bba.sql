CREATE OR REPLACE FUNCTION public.market_screener_core_candidates(
  _min_price numeric DEFAULT NULL,
  _max_price numeric DEFAULT NULL,
  _min_market_cap numeric DEFAULT NULL,
  _max_market_cap numeric DEFAULT NULL,
  _min_change_pct numeric DEFAULT NULL,
  _max_change_pct numeric DEFAULT NULL,
  _min_volume numeric DEFAULT NULL,
  _max_volume numeric DEFAULT NULL,
  _volume_above_avg boolean DEFAULT NULL,
  _liquid_only boolean DEFAULT false,
  _limit integer DEFAULT 600,
  _after_symbol text DEFAULT NULL
)
RETURNS TABLE(
  symbol text,
  exchange text,
  company_name text,
  trade_date date,
  close numeric,
  previous_close numeric,
  change_abs numeric,
  change_pct numeric,
  change_pct_raw numeric,
  volume numeric,
  vol_avg30 numeric,
  market_cap numeric,
  mcap_basis text,
  breakout_score_v4 numeric,
  is_liquid_tradable boolean,
  live_provider text,
  live_as_of timestamptz,
  live_sweep_id uuid,
  quote_state text,
  universe_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH promoted AS (
    SELECT r.sweep_id, r.session_date, r.as_of, r.expected_count
    FROM public.market_live_price_runs r
    WHERE r.status = 'complete'
      AND r.completed_at IS NOT NULL
    ORDER BY r.completed_at DESC
    LIMIT 1
  )
  SELECT
    s.symbol::text,
    s.exchange::text,
    s.company_name::text,
    s.trade_date::date,
    s.close::numeric,
    s.previous_close::numeric,
    s.change_abs::numeric,
    s.change_pct::numeric,
    s.change_pct_raw::numeric,
    s.volume::numeric,
    s.vol_avg30::numeric,
    s.market_cap::numeric,
    s.mcap_basis::text,
    s.breakout_score_v4::numeric,
    s.is_liquid_tradable::boolean,
    s.live_provider::text,
    s.live_as_of::timestamptz,
    s.live_sweep_id::uuid,
    s.quote_state::text,
    p.expected_count::bigint
  FROM public.market_screener_rows s
  CROSS JOIN promoted p
  WHERE s.exchange = 'NSE'
    AND s.instrument_type = 'EQ'
    AND s.is_active = true
    AND s.in_universe = true
    AND s.quote_state = 'live'
    AND s.live_sweep_id = p.sweep_id
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
    AND (_after_symbol IS NULL OR s.symbol > _after_symbol)
  ORDER BY s.symbol
  LIMIT LEAST(GREATEST(COALESCE(_limit, 600), 1), 600)
$$;

REVOKE ALL ON FUNCTION public.market_screener_core_candidates(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.market_screener_core_candidates(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean,integer,text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.market_screener_et_parity(numeric,numeric,numeric,boolean,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.market_screener_et_parity(numeric,numeric,numeric,boolean,integer,text) TO authenticated, service_role;

SELECT public.market_penny_sweep(1000, 50);
SELECT public.refresh_market_screener_snapshot();