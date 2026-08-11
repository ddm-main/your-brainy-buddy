ALTER TABLE public.market_sweep_snapshot ADD COLUMN IF NOT EXISTS watch_hash text;
ALTER TABLE public.system_maintenance_log ADD COLUMN IF NOT EXISTS details jsonb;

CREATE OR REPLACE FUNCTION public.market_live_watch_universe()
RETURNS TABLE(symbol text, yahoo_symbol text, series text, total_shares_cr numeric, token text, kotak_segment text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH watched AS (
    SELECT DISTINCT upper(s) AS symbol FROM (
      SELECT symbol AS s FROM public.market_watchlist_items
      UNION ALL SELECT symbol FROM public.market_holdings WHERE quantity > 0
      UNION ALL SELECT symbol FROM public.market_positions WHERE closed_at IS NULL
      UNION ALL SELECT symbol FROM public.market_gtt_orders WHERE status IN ('pending','active','armed')
      UNION ALL SELECT symbol FROM public.market_alerts WHERE is_active
      UNION ALL SELECT symbol FROM public.market_autotrade_rules WHERE is_armed AND symbol IS NOT NULL
      UNION ALL SELECT m.symbol FROM public.market_index_members m
        WHERE EXISTS (
          SELECT 1 FROM public.market_index_watch w
          WHERE w.constituents_slug = m.index_key OR w.symbol = m.index_key
        )
    ) t WHERE s IS NOT NULL AND length(s) > 0
  )
  SELECT u.symbol, u.yahoo_symbol, u.series, u.total_shares_cr, u.token, u.kotak_segment
  FROM public.market_universe u
  JOIN watched w ON w.symbol = upper(u.symbol)
  WHERE u.exchange = 'NSE' AND u.instrument_type = 'EQ'
  ORDER BY u.symbol;
$$;

GRANT EXECUTE ON FUNCTION public.market_live_watch_universe() TO service_role;