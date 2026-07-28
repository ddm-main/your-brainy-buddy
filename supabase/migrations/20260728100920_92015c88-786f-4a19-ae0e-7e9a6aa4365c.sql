
CREATE OR REPLACE FUNCTION public.market_archive_candidates(_limit integer DEFAULT 40, _hot_tracked integer DEFAULT 730, _hot_other integer DEFAULT 400)
 RETURNS TABLE(symbol text, exchange text, cutoff date, cold_bars integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Cheap rotation: never aggregate the whole price table (that timed out).
  -- Pick active symbols whose archive object is missing or stale; the edge
  -- function itself skips any symbol with no rows older than the cutoff.
  WITH tracked AS (
    SELECT DISTINCT s FROM (
      SELECT symbol s FROM public.market_watchlist_items
      UNION SELECT symbol FROM public.market_holdings
      UNION SELECT symbol FROM public.market_positions
      UNION SELECT symbol FROM public.market_index_members
    ) x
  )
  SELECT st.symbol,
         st.exchange,
         (current_date - CASE WHEN t.s IS NOT NULL
                              THEN GREATEST(365, _hot_tracked)
                              ELSE GREATEST(200, _hot_other) END)::date AS cutoff,
         0::int AS cold_bars
  FROM public.market_stocks st
  LEFT JOIN tracked t ON t.s = st.symbol
  LEFT JOIN public.market_archive_index a
         ON a.symbol = st.symbol AND a.exchange = st.exchange
  WHERE st.is_active = true
    AND st.exchange = 'NSE'
    AND COALESCE(a.updated_at, '1970-01-01'::timestamptz) < now() - interval '20 hours'
  ORDER BY a.updated_at ASC NULLS FIRST, st.symbol ASC
  LIMIT GREATEST(1, LEAST(_limit, 200))
$function$;
