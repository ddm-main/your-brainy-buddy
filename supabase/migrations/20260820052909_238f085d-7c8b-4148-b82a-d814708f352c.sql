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
  _limit integer DEFAULT 500,
  _after_symbol text DEFAULT NULL
)
RETURNS TABLE(symbol text, exchange text, company_name text, trade_date date, close numeric, previous_close numeric, change_abs numeric, change_pct numeric, change_pct_raw numeric, volume numeric, vol_avg30 numeric, market_cap numeric, mcap_basis text, breakout_score_v4 numeric, is_liquid_tradable boolean, live_provider text, live_as_of timestamptz, live_sweep_id uuid, quote_state text, snapshot_token text, snapshot_session date, universe_count bigint, candidate_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH promoted AS (
    SELECT r.sweep_id, r.session_date, r.as_of
    FROM public.market_live_price_runs r
    WHERE r.status = 'complete'
      AND r.completed_at IS NOT NULL
    ORDER BY r.as_of DESC
    LIMIT 1
  ), universe AS (
    SELECT count(*)::bigint AS n
    FROM public.market_screener_rows s
    CROSS JOIN promoted p
    WHERE s.exchange = 'NSE' AND s.instrument_type = 'EQ'
      AND s.is_active IS TRUE AND s.in_universe IS TRUE
      AND s.quote_state = 'live' AND s.live_sweep_id = p.sweep_id
  ), eligible AS (
    SELECT
      s.*, p.session_date, p.as_of, u.n AS universe_count,
      count(*) OVER () AS candidate_count
    FROM public.market_screener_rows s
    CROSS JOIN promoted p
    CROSS JOIN universe u
    WHERE s.exchange = 'NSE'
      AND s.instrument_type = 'EQ'
      AND s.is_active IS TRUE
      AND s.in_universe IS TRUE
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
      AND (_volume_above_avg IS DISTINCT FROM false OR (s.vol_avg30 > 0 AND s.volume <= s.vol_avg30))
      AND (_liquid_only IS NOT TRUE OR s.is_liquid_tradable IS TRUE)
  )
  SELECT
    e.symbol::text, e.exchange::text, e.company_name::text, e.trade_date::date,
    e.close::numeric, e.previous_close::numeric, e.change_abs::numeric, e.change_pct::numeric,
    e.change_pct_raw::numeric, e.volume::numeric, e.vol_avg30::numeric, e.market_cap::numeric,
    e.mcap_basis::text, e.breakout_score_v4::numeric, e.is_liquid_tradable::boolean,
    e.live_provider::text, e.as_of::timestamptz, e.live_sweep_id::uuid, e.quote_state::text,
    (e.live_sweep_id::text || '@' || extract(epoch FROM e.as_of)::bigint::text)::text,
    e.session_date::date, e.universe_count::bigint, e.candidate_count::bigint
  FROM eligible e
  WHERE (_after_symbol IS NULL OR e.symbol > _after_symbol)
  ORDER BY e.symbol
  LIMIT least(greatest(coalesce(_limit, 600), 1), 600);
$$;

REVOKE ALL ON FUNCTION public.market_screener_core_candidates(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.market_screener_core_candidates(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean,integer,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.market_screener_snapshot_diagnostic(
  _min_price numeric DEFAULT NULL,
  _max_price numeric DEFAULT NULL,
  _min_market_cap numeric DEFAULT NULL,
  _max_market_cap numeric DEFAULT NULL,
  _min_change_pct numeric DEFAULT NULL,
  _max_change_pct numeric DEFAULT NULL,
  _min_volume numeric DEFAULT NULL,
  _max_volume numeric DEFAULT NULL,
  _volume_above_avg boolean DEFAULT NULL,
  _liquid_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH promoted AS (
    SELECT r.sweep_id, r.session_date, r.as_of
    FROM public.market_live_price_runs r
    WHERE r.status = 'complete'
      AND r.completed_at IS NOT NULL
    ORDER BY r.as_of DESC
    LIMIT 1
  ), classified AS (
    SELECT
      s.symbol,
      p.sweep_id,
      p.session_date,
      p.as_of,
      CASE
        WHEN s.quote_state <> 'live' OR s.live_sweep_id IS DISTINCT FROM p.sweep_id THEN 'not_on_promoted_sweep'
        WHEN _min_price IS NOT NULL AND s.close < _min_price THEN 'price_below_min'
        WHEN _max_price IS NOT NULL AND s.close > _max_price THEN 'price_above_max'
        WHEN _min_market_cap IS NOT NULL AND s.market_cap < _min_market_cap THEN 'market_cap_below_min'
        WHEN _max_market_cap IS NOT NULL AND s.market_cap > _max_market_cap THEN 'market_cap_above_max'
        WHEN _min_change_pct IS NOT NULL AND s.change_pct_raw < _min_change_pct THEN 'return_below_min'
        WHEN _max_change_pct IS NOT NULL AND s.change_pct_raw > _max_change_pct THEN 'return_above_max'
        WHEN _min_volume IS NOT NULL AND s.volume < _min_volume THEN 'volume_below_min'
        WHEN _max_volume IS NOT NULL AND s.volume > _max_volume THEN 'volume_above_max'
        WHEN _volume_above_avg IS NOT NULL AND coalesce(s.vol_avg30, 0) <= 0 THEN 'volume_average_missing'
        WHEN _volume_above_avg IS TRUE AND s.volume <= s.vol_avg30 THEN 'volume_not_above_average'
        WHEN _volume_above_avg IS FALSE AND s.volume > s.vol_avg30 THEN 'volume_above_average'
        WHEN _liquid_only IS TRUE AND s.is_liquid_tradable IS NOT TRUE THEN 'not_liquid'
        ELSE 'matched'
      END AS reason
    FROM public.market_screener_rows s
    CROSS JOIN promoted p
    WHERE s.exchange = 'NSE'
      AND s.instrument_type = 'EQ'
      AND s.is_active IS TRUE
      AND s.in_universe IS TRUE
  ), reasons AS (
    SELECT reason, count(*)::integer AS n FROM classified GROUP BY reason
  )
  SELECT jsonb_build_object(
    'snapshot_token', (SELECT sweep_id::text || '@' || extract(epoch FROM as_of)::bigint::text FROM promoted),
    'session_date', (SELECT session_date FROM promoted),
    'as_of', (SELECT as_of FROM promoted),
    'universe_count', (SELECT count(*) FROM classified),
    'matched_symbols', coalesce((SELECT jsonb_agg(symbol ORDER BY symbol) FROM classified WHERE reason = 'matched'), '[]'::jsonb),
    'reason_counts', coalesce((SELECT jsonb_object_agg(reason, n) FROM reasons), '{}'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.market_screener_snapshot_diagnostic(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.market_screener_snapshot_diagnostic(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,boolean,boolean) TO authenticated, service_role;