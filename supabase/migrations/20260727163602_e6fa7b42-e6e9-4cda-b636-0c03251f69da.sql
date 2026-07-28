ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS history_backfill_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS history_backfill_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS history_backfill_error text;

DROP FUNCTION IF EXISTS public.market_history_backfill_candidates(integer, integer);

CREATE FUNCTION public.market_history_backfill_candidates(_limit integer DEFAULT 40, _min_bars integer DEFAULT 750)
RETURNS TABLE(symbol text, exchange text, yahoo_symbol text, bars integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.symbol,
         s.exchange,
         s.yahoo_symbol,
         COALESCE(d.bars, 0)::int AS bars
  FROM public.market_stocks s
  LEFT JOIN (
    SELECT p.symbol,
           p.exchange,
           COUNT(*)::int AS bars,
           GREATEST(1, (MAX(p.trade_date) - MIN(p.trade_date)) / 30.4375) AS months
    FROM public.market_daily_prices p
    GROUP BY p.symbol, p.exchange
  ) d ON d.symbol = s.symbol AND d.exchange = s.exchange
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND (
      COALESCE(d.bars, 0) < GREATEST(30, LEAST(_min_bars, 5000))
      -- sparse / wrong-grain: real daily NSE history is ~21 bars per month
      OR (d.bars IS NOT NULL AND d.bars / d.months < 12)
    )
    -- A symbol that can never be fetched (delisted, renamed, no Yahoo listing)
    -- must not re-occupy a slot on every run: after 5 failures it drops to one
    -- retry per week.
    AND (
      COALESCE(s.history_backfill_attempts, 0) < 5
      OR COALESCE(s.history_backfill_attempted_at, '1970-01-01'::timestamptz) < now() - interval '7 days'
    )
  -- Oldest attempt first so the universe rotates instead of replaying the head.
  ORDER BY s.history_backfill_attempted_at ASC NULLS FIRST,
           COALESCE(d.bars, 0) DESC,
           s.symbol ASC
  LIMIT GREATEST(1, LEAST(_limit, 200))
$$;

REVOKE ALL ON FUNCTION public.market_history_backfill_candidates(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_history_backfill_candidates(integer, integer) TO service_role;