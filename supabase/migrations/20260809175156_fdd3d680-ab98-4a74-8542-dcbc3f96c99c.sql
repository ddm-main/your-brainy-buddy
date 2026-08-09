ALTER TABLE public.market_feed_heartbeat ADD COLUMN IF NOT EXISTS path text;

DELETE FROM public.market_provider_health
WHERE provider = 'kotak_neo' AND endpoint = 'getOHLCV' AND ok = false AND error LIKE 'no token for%';

CREATE OR REPLACE FUNCTION public.market_provider_stats_24h()
RETURNS TABLE(provider text, attempts integer, ok_count integer, ok_rate integer, p50 integer, last_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT h.provider,
         count(*)::int AS attempts,
         count(*) FILTER (WHERE h.ok)::int AS ok_count,
         round(100.0 * count(*) FILTER (WHERE h.ok) / greatest(count(*), 1))::int AS ok_rate,
         percentile_disc(0.5) WITHIN GROUP (
           ORDER BY h.latency_ms
         ) FILTER (WHERE h.latency_ms IS NOT NULL AND h.latency_ms > 0)::int AS p50,
         max(h.created_at) AS last_at
  FROM public.market_provider_health h
  WHERE h.created_at > now() - interval '24 hours'
  GROUP BY h.provider
$$;

GRANT EXECUTE ON FUNCTION public.market_provider_stats_24h() TO authenticated;
GRANT EXECUTE ON FUNCTION public.market_provider_stats_24h() TO service_role;