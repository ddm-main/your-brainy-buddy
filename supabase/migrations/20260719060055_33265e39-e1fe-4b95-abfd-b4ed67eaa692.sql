CREATE OR REPLACE VIEW public.market_fundamentals_sync_queue AS
SELECT
  s.symbol,
  s.exchange,
  s.company_name,
  s.yahoo_symbol,
  s.last_fundamentals_sync_at,
  f.sync_status,
  f.last_attempted_at,
  CASE
    WHEN f.symbol IS NULL THEN 0
    WHEN f.sync_status = 'failed'
      AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '12 hours' THEN 1
    WHEN f.sync_status = 'partial'
      AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '24 hours' THEN 2
    WHEN COALESCE(f.updated_at, f.data_as_of, f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '1 day' THEN 3
    ELSE 9
  END AS queue_priority
FROM public.market_stocks s
LEFT JOIN public.market_fundamentals_global f
  ON f.symbol = s.symbol AND f.exchange = s.exchange
WHERE s.is_active = true
  AND (
    f.symbol IS NULL
    OR (
      f.sync_status = 'failed'
      AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '12 hours'
    )
    OR (
      f.sync_status = 'partial'
      AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '24 hours'
    )
    OR COALESCE(f.updated_at, f.data_as_of, f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '1 day'
  );

CREATE OR REPLACE FUNCTION public.claim_market_fundamentals_sync(_limit integer DEFAULT 40)
RETURNS TABLE(
  symbol text,
  exchange text,
  company_name text,
  yahoo_symbol text,
  queue_priority integer,
  last_attempted_at timestamp with time zone,
  last_fundamentals_sync_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
        WHEN f.sync_status = 'failed'
          AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '12 hours' THEN 1
        WHEN f.sync_status = 'partial'
          AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '24 hours' THEN 2
        WHEN COALESCE(f.updated_at, f.data_as_of, f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '1 day' THEN 3
        ELSE 9
      END AS queue_priority
    FROM public.market_stocks s
    LEFT JOIN public.market_fundamentals_global f
      ON f.symbol = s.symbol AND f.exchange = s.exchange
    WHERE s.is_active = true
      AND (
        f.symbol IS NULL
        OR (
          f.sync_status = 'failed'
          AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '12 hours'
        )
        OR (
          f.sync_status = 'partial'
          AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '24 hours'
        )
        OR COALESCE(f.updated_at, f.data_as_of, f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '1 day'
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
$function$;