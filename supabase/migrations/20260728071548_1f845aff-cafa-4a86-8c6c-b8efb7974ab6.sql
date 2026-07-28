DROP VIEW public.market_screener_rows;
DROP MATERIALIZED VIEW public.market_screener_snapshot;

CREATE TABLE public.market_screener_snapshot AS
SELECT *, now() AS refreshed_at FROM public.market_screener_live;

ALTER TABLE public.market_screener_snapshot
  ADD CONSTRAINT market_screener_snapshot_pk PRIMARY KEY (symbol, exchange);
CREATE INDEX market_screener_snapshot_exch_active
  ON public.market_screener_snapshot (exchange, is_active);
CREATE INDEX market_screener_snapshot_breakout
  ON public.market_screener_snapshot (breakout_score DESC NULLS LAST, symbol);
CREATE INDEX market_screener_snapshot_mcap
  ON public.market_screener_snapshot (market_cap);
CREATE INDEX market_screener_snapshot_close
  ON public.market_screener_snapshot (close);
CREATE INDEX market_screener_snapshot_change
  ON public.market_screener_snapshot (change_pct);

GRANT SELECT ON public.market_screener_snapshot TO anon, authenticated;
GRANT ALL ON public.market_screener_snapshot TO service_role;

ALTER TABLE public.market_screener_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Screener snapshot is readable"
  ON public.market_screener_snapshot FOR SELECT
  USING (true);

CREATE VIEW public.market_screener_rows
WITH (security_invoker = on) AS
SELECT * FROM public.market_screener_snapshot;
GRANT SELECT ON public.market_screener_rows TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.refresh_market_screener_snapshot();
CREATE FUNCTION public.refresh_market_screener_snapshot()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.market_screener_snapshot;
  INSERT INTO public.market_screener_snapshot
  SELECT *, now() FROM public.market_screener_live;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_market_screener_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_market_screener_snapshot() TO service_role;