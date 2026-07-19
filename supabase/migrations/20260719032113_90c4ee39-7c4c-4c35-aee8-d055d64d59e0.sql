DROP VIEW IF EXISTS public.market_fundamentals_sync_queue;
CREATE VIEW public.market_fundamentals_sync_queue
WITH (security_invoker = true)
AS
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
    WHEN f.sync_status = 'failed' AND COALESCE(f.last_attempted_at, 'epoch'::timestamptz) < now() - interval '12 hours' THEN 1
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
    OR (f.sync_status = 'failed' AND COALESCE(f.last_attempted_at, 'epoch'::timestamptz) < now() - interval '12 hours')
    OR s.last_fundamentals_sync_at IS NULL
    OR s.last_fundamentals_sync_at < now() - interval '7 days'
  );

GRANT SELECT ON public.market_fundamentals_sync_queue TO service_role;