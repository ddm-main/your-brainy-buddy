DO $migration$
DECLARE
  view_sql text;
BEGIN
  SELECT pg_get_viewdef('public.market_screener_rows'::regclass, true)
    INTO view_sql;

  IF position('FROM market_eod_nse e' IN view_sql) = 0 THEN
    RAISE EXCEPTION 'Expected market_eod_nse volume-history source was not found in market_screener_rows';
  END IF;

  view_sql := replace(
    view_sql,
    'FROM market_eod_nse e',
    'FROM market_daily_prices e'
  );

  EXECUTE 'CREATE OR REPLACE VIEW public.market_screener_rows WITH (security_invoker=on) AS ' || view_sql;
END
$migration$;

GRANT SELECT ON public.market_screener_rows TO anon, authenticated;
GRANT ALL ON public.market_screener_rows TO service_role;