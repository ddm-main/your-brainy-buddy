ALTER TABLE public.market_surface_probes
  ADD COLUMN IF NOT EXISTS is_primary_path boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS supported boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.market_feed_freshness()
RETURNS TABLE(table_name text, column_name text, last_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  targets text[][] := ARRAY[
    ARRAY['market_quotes','fetched_at'],
    ARRAY['market_daily_prices','created_at'],
    ARRAY['market_intraday_prices','fetched_at'],
    ARRAY['market_eod_nse','fetched_at'],
    ARRAY['market_funds','synced_at'],
    ARRAY['market_holdings','updated_at'],
    ARRAY['market_positions','updated_at'],
    ARRAY['market_fundamentals_global','updated_at'],
    ARRAY['market_shares_outstanding','updated_at'],
    ARRAY['market_indicators_cache','computed_at'],
    ARRAY['market_index_members','updated_at'],
    ARRAY['corporate_actions','updated_at'],
    ARRAY['market_news','created_at']
  ];
  i integer;
  t text;
  c text;
  v timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  FOR i IN 1 .. array_length(targets, 1) LOOP
    t := targets[i][1];
    c := targets[i][2];
    BEGIN
      EXECUTE format('SELECT max(%I) FROM public.%I', c, t) INTO v;
    EXCEPTION WHEN OTHERS THEN
      v := NULL;
    END;
    table_name := t;
    column_name := c;
    last_at := v;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.market_feed_freshness() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_feed_freshness() TO authenticated;
GRANT EXECUTE ON FUNCTION public.market_feed_freshness() TO service_role;