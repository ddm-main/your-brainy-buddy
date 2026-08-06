DO $$
DECLARE
  d text;
  old_join text := 'LEFT JOIN market_stock_scores sc ON sc.symbol = s.symbol AND sc.exchange = s.exchange AND sc.trade_date = en.trade_date';
  new_join text := 'LEFT JOIN LATERAL ( SELECT z.* FROM market_stock_scores z WHERE z.symbol = s.symbol AND z.exchange = s.exchange ORDER BY z.trade_date DESC LIMIT 1) sc ON true';
  old_vol text := 'en.volume IS NOT NULL AND sc.vol_avg30 IS NOT NULL AND sc.vol_avg30 > 0::numeric AND en.volume::numeric > sc.vol_avg30 AS vol_gt_avg30';
  new_vol text := 'CASE WHEN en.volume IS NULL OR sc.vol_avg30 IS NULL OR sc.vol_avg30 <= 0::numeric THEN NULL::boolean ELSE en.volume::numeric > sc.vol_avg30 END AS vol_gt_avg30';
  old_std text := 'sc_any.trade_date AS score_trade_date';
  new_std text := 'sc.trade_date AS score_trade_date';
  old_any text := 'LEFT JOIN market_stock_scores sc_any ON sc_any.symbol = s.symbol AND sc_any.exchange = s.exchange';
BEGIN
  d := pg_get_viewdef('public.market_screener_live'::regclass, true);
  IF position(old_join in d) = 0 THEN RAISE EXCEPTION 'score join clause not found'; END IF;
  IF position(old_vol in d) = 0 THEN RAISE EXCEPTION 'vol_gt_avg30 expression not found'; END IF;
  IF position(old_std in d) = 0 THEN RAISE EXCEPTION 'score_trade_date expression not found'; END IF;
  IF position(old_any in d) = 0 THEN RAISE EXCEPTION 'sc_any join not found'; END IF;
  d := replace(d, old_join, new_join);
  d := replace(d, old_vol, new_vol);
  d := replace(d, old_std, new_std);
  d := replace(d, old_any, '');
  d := rtrim(btrim(d), ';');
  EXECUTE 'CREATE OR REPLACE VIEW public.market_screener_live AS ' || d;
END $$;

ALTER TABLE public.market_screener_snapshot ALTER COLUMN vol_gt_avg30 DROP NOT NULL;

SELECT public.refresh_market_screener_snapshot();
