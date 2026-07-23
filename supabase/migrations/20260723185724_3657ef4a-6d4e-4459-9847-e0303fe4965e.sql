
-- 1) Normalized breadth latest view (freezes the correct column names so
--    future clients can't repeat the fii_net_cash bug).
CREATE OR REPLACE VIEW public.market_breadth_latest
WITH (security_invoker = on) AS
SELECT
  trade_date,
  advances,
  declines,
  unchanged,
  pct_above_ema20,
  pct_above_ema50,
  pct_above_ema200,
  avg_rsi,
  nifty_close,
  nifty_change_pct,
  regime,
  india_vix,
  fii_net_cr,
  dii_net_cr,
  new_highs,
  new_lows,
  market_score,
  computed_at
FROM public.market_breadth_daily
ORDER BY trade_date DESC
LIMIT 1;

GRANT SELECT ON public.market_breadth_latest TO authenticated;
GRANT SELECT ON public.market_breadth_latest TO anon;

-- 2) Top movers materialized view (top 20 gainers + top 20 losers).
DROP MATERIALIZED VIEW IF EXISTS public.market_top_movers_daily;
CREATE MATERIALIZED VIEW public.market_top_movers_daily AS
WITH latest AS (
  SELECT MAX(trade_date) AS d FROM public.market_stock_scores WHERE change_pct IS NOT NULL
),
scored AS (
  SELECT s.symbol, s.exchange, s.sector, s.close, s.change_pct, s.volume, s.rel_volume,
         s.rsi14, s.breakout_score, s.trade_date
  FROM public.market_stock_scores s, latest
  WHERE s.trade_date = latest.d AND s.change_pct IS NOT NULL AND s.close IS NOT NULL
),
gainers AS (
  SELECT *, 'gain'::text AS direction, ROW_NUMBER() OVER (ORDER BY change_pct DESC) AS rn
  FROM scored
),
losers AS (
  SELECT *, 'lose'::text AS direction, ROW_NUMBER() OVER (ORDER BY change_pct ASC) AS rn
  FROM scored
)
SELECT * FROM gainers WHERE rn <= 20
UNION ALL
SELECT * FROM losers  WHERE rn <= 20;

CREATE UNIQUE INDEX IF NOT EXISTS market_top_movers_daily_pk
  ON public.market_top_movers_daily (direction, rn);

GRANT SELECT ON public.market_top_movers_daily TO authenticated;
GRANT SELECT ON public.market_top_movers_daily TO anon;

-- 3) Refresh helper (called by the aggregates cron / edge fn).
CREATE OR REPLACE FUNCTION public.refresh_market_top_movers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.market_top_movers_daily;
EXCEPTION WHEN OTHERS THEN
  -- CONCURRENTLY needs an existing populated MV; first-run fallback:
  REFRESH MATERIALIZED VIEW public.market_top_movers_daily;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_market_top_movers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_market_top_movers() TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_market_top_movers() TO service_role;
