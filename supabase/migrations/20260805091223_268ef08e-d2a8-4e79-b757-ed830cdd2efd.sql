DO $$
DECLARE d text; nd text;
BEGIN
  SELECT pg_get_viewdef('public.market_screener_rows'::regclass, true) INTO d;
  IF position('breakout_score_v4' in d) > 0 THEN
    RAISE NOTICE 'already present';
    RETURN;
  END IF;
  nd := replace(d, E'\n   FROM market_screener_snapshot s', E',\n    mss.breakout_score_v4\n   FROM market_screener_snapshot s');
  IF nd = d THEN
    RAISE EXCEPTION 'could not locate FROM market_screener_snapshot s in view definition';
  END IF;
  nd := rtrim(rtrim(nd), ';');
  nd := nd || E'\n     LEFT JOIN public.market_stock_scores mss ON mss.symbol = s.symbol AND mss.exchange = s.exchange';
  EXECUTE 'CREATE OR REPLACE VIEW public.market_screener_rows AS ' || nd;
END $$;

GRANT SELECT ON public.market_screener_rows TO authenticated;
GRANT SELECT ON public.market_screener_rows TO service_role;