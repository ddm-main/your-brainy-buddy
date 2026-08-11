CREATE OR REPLACE FUNCTION public.market_screener_et_parity(
  _min_price numeric DEFAULT 100,
  _min_market_cap numeric DEFAULT 1000,
  _min_change_pct numeric DEFAULT 5,
  _volume_above_avg boolean DEFAULT true,
  _limit integer DEFAULT 500,
  _after_symbol text DEFAULT NULL
)
RETURNS TABLE(
  symbol text,
  exchange text,
  company_name text,
  trade_date date,
  close numeric,
  previous_close numeric,
  change_pct numeric,
  change_pct_raw numeric,
  volume bigint,
  vol_avg30 numeric,
  market_cap numeric,
  breakout_score_v4 integer,
  is_liquid_tradable boolean,
  live_as_of timestamptz,
  quote_state text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    r.symbol::text,
    r.exchange::text,
    r.company_name::text,
    r.trade_date::date,
    r.close::numeric,
    r.previous_close::numeric,
    r.change_pct::numeric,
    r.change_pct_raw::numeric,
    r.volume::bigint,
    r.vol_avg30::numeric,
    r.market_cap::numeric,
    r.breakout_score_v4::integer,
    r.is_liquid_tradable::boolean,
    r.live_as_of::timestamptz,
    r.quote_state::text
  FROM public.market_screener_rows r
  JOIN public.market_universe u
    ON u.symbol = r.symbol AND u.exchange = r.exchange
  WHERE r.exchange = 'NSE'
    AND r.instrument_type = 'EQ'
    AND r.close > _min_price
    AND r.market_cap > _min_market_cap
    AND r.change_pct_raw > _min_change_pct
    AND (_volume_above_avg IS FALSE OR (r.vol_avg30 > 0 AND r.volume > r.vol_avg30))
    AND (_after_symbol IS NULL OR r.symbol > _after_symbol)
  ORDER BY r.symbol
  LIMIT LEAST(GREATEST(_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION public.market_screener_et_parity(numeric,numeric,numeric,boolean,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_screener_et_parity(numeric,numeric,numeric,boolean,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.market_screener_et_parity(numeric,numeric,numeric,boolean,integer,text) TO service_role;