CREATE OR REPLACE FUNCTION public.market_penny_sweep(_min_cap_cr numeric DEFAULT 1000, _min_price numeric DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_symbols text[];
  v_excluded integer := 0;
  v_purged integer := 0;
BEGIN
  SELECT COALESCE(array_agg(r.symbol ORDER BY r.symbol), ARRAY[]::text[])
  INTO v_symbols
  FROM public.market_screener_rows r
  WHERE r.exchange = 'NSE'
    AND r.instrument_type = 'EQ'
    AND r.is_active = true
    AND r.in_universe = true
    AND (
      r.market_cap IS NULL OR r.market_cap < _min_cap_cr
      OR r.close IS NULL OR r.close < _min_price
    );

  IF cardinality(v_symbols) = 0 THEN
    RETURN jsonb_build_object('excluded', 0, 'purged', 0, 'symbols', '[]'::jsonb);
  END IF;

  INSERT INTO public.market_excluded_symbols (symbol, exchange, reason, excluded_at)
  SELECT u.symbol, 'NSE',
         'penny universe: requires current market cap >= ' || _min_cap_cr || ' Cr and LTP >= ' || _min_price,
         now()
  FROM unnest(v_symbols) AS u(symbol)
  ON CONFLICT (symbol, exchange) DO UPDATE
    SET reason = EXCLUDED.reason,
        excluded_at = EXCLUDED.excluded_at;
  GET DIAGNOSTICS v_excluded = ROW_COUNT;

  UPDATE public.market_stocks
  SET is_active = false, in_universe = false
  WHERE exchange = 'NSE' AND symbol = ANY(v_symbols);

  SELECT public.market_penny_purge(v_symbols) INTO v_purged;

  RETURN jsonb_build_object(
    'excluded', v_excluded,
    'purged', COALESCE(v_purged, 0),
    'symbols', to_jsonb(v_symbols)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.market_penny_sweep(numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_penny_sweep(numeric,numeric) TO service_role;

SELECT public.market_penny_sweep(1000, 50);
SELECT public.refresh_market_screener_snapshot();