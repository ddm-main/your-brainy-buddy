CREATE OR REPLACE FUNCTION public.market_live_watch_universe()
RETURNS TABLE(symbol text, yahoo_symbol text, series text, total_shares_cr numeric, token text, kotak_segment text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH slugs AS (
    SELECT DISTINCT CASE upper(regexp_replace(coalesce(w.constituents_slug,''), '[^a-zA-Z0-9]', '', 'g'))
             WHEN 'NIFTYBANK' THEN 'BANKNIFTY'
             ELSE upper(regexp_replace(coalesce(w.constituents_slug,''), '[^a-zA-Z0-9]', '', 'g'))
           END AS key
    FROM public.market_index_watch w
    WHERE coalesce(w.constituents_slug,'') <> ''
  ),
  watched AS (
    SELECT DISTINCT upper(s) AS symbol FROM (
      SELECT symbol AS s FROM public.market_watchlist_items
      UNION ALL SELECT symbol FROM public.market_holdings WHERE quantity > 0
      UNION ALL SELECT symbol FROM public.market_positions WHERE closed_at IS NULL
      UNION ALL SELECT symbol FROM public.market_gtt_orders WHERE status IN ('pending','active','armed')
      UNION ALL SELECT symbol FROM public.market_alerts WHERE is_active
      UNION ALL SELECT symbol FROM public.market_autotrade_rules WHERE is_armed AND symbol IS NOT NULL
      UNION ALL SELECT m.symbol FROM public.market_index_members m
        JOIN slugs g ON g.key = upper(m.index_key)
    ) t WHERE s IS NOT NULL AND length(s) > 0
  )
  SELECT u.symbol, u.yahoo_symbol, u.series, u.total_shares_cr, u.token, u.kotak_segment
  FROM public.market_universe u
  JOIN watched w ON w.symbol = upper(u.symbol)
  WHERE u.exchange = 'NSE' AND u.instrument_type = 'EQ'
  ORDER BY u.symbol;
$$;

GRANT EXECUTE ON FUNCTION public.market_live_watch_universe() TO service_role;