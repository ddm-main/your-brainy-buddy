-- 1. Keep the expensive computation, but rename it out of the request path
ALTER VIEW public.market_screener_rows RENAME TO market_screener_live;

-- 2. Materialize it
CREATE MATERIALIZED VIEW public.market_screener_snapshot AS
SELECT *, now() AS refreshed_at FROM public.market_screener_live;

CREATE UNIQUE INDEX market_screener_snapshot_pk
  ON public.market_screener_snapshot (symbol, exchange);
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

-- 3. Re-expose the stable name, now backed by the snapshot
CREATE VIEW public.market_screener_rows
WITH (security_invoker = on) AS
SELECT * FROM public.market_screener_snapshot;

GRANT SELECT ON public.market_screener_snapshot TO anon, authenticated, service_role;
GRANT SELECT ON public.market_screener_rows TO anon, authenticated, service_role;
GRANT SELECT ON public.market_screener_live TO service_role;

-- 4. Refresh entry point for the sync pipeline
CREATE OR REPLACE FUNCTION public.refresh_market_screener_snapshot()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.market_screener_snapshot;
EXCEPTION WHEN OTHERS THEN
  REFRESH MATERIALIZED VIEW public.market_screener_snapshot;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_market_screener_snapshot() TO authenticated, service_role;