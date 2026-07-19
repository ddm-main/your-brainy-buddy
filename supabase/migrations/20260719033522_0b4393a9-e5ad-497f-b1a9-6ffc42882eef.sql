CREATE OR REPLACE FUNCTION public.claim_market_fundamentals_sync(_limit integer DEFAULT 40)
RETURNS TABLE(
  symbol text,
  exchange text,
  company_name text,
  yahoo_symbol text,
  queue_priority integer,
  last_attempted_at timestamptz,
  last_fundamentals_sync_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT
      s.ctid,
      s.symbol,
      s.exchange,
      s.company_name,
      s.yahoo_symbol,
      s.last_fundamentals_sync_at,
      f.last_attempted_at,
      CASE
        WHEN f.symbol IS NULL THEN 0
        WHEN f.sync_status = 'failed' AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '12 hours' THEN 1
        WHEN s.last_fundamentals_sync_at IS NULL THEN 2
        WHEN s.last_fundamentals_sync_at < now() - interval '7 days' THEN 3
        ELSE 9
      END AS queue_priority
    FROM public.market_stocks s
    LEFT JOIN public.market_fundamentals_global f
      ON f.symbol = s.symbol AND f.exchange = s.exchange
    WHERE s.is_active = true
      AND s.in_universe = true
      AND (
        f.symbol IS NULL
        OR (f.sync_status = 'failed' AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '12 hours')
        OR s.last_fundamentals_sync_at IS NULL
        OR s.last_fundamentals_sync_at < now() - interval '7 days'
      )
    ORDER BY queue_priority ASC, f.last_attempted_at ASC NULLS FIRST, s.last_fundamentals_sync_at ASC NULLS FIRST, s.symbol ASC
    LIMIT GREATEST(1, LEAST(_limit, 200))
    FOR UPDATE OF s SKIP LOCKED
  ), claimed AS (
    UPDATE public.market_stocks s
       SET last_fundamentals_sync_at = now()
      FROM candidates c
     WHERE s.ctid = c.ctid
     RETURNING s.symbol, s.exchange, s.company_name, s.yahoo_symbol, c.queue_priority, c.last_attempted_at, s.last_fundamentals_sync_at
  )
  SELECT claimed.symbol, claimed.exchange, claimed.company_name, claimed.yahoo_symbol,
         claimed.queue_priority, claimed.last_attempted_at, claimed.last_fundamentals_sync_at
  FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_market_fundamentals_sync(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_market_fundamentals_sync(integer) TO service_role;