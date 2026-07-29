
CREATE TABLE IF NOT EXISTS public.market_route_health (
  route text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  open_until timestamptz,
  opened_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.market_route_health TO authenticated;
GRANT ALL ON public.market_route_health TO service_role;
ALTER TABLE public.market_route_health ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_health_readable_to_authenticated"
  ON public.market_route_health FOR SELECT TO authenticated USING (true);
