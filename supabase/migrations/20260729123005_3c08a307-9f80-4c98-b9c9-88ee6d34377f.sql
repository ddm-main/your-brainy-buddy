CREATE TABLE public.market_surface_probes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surface text NOT NULL,
  provider text NOT NULL,
  ok boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'failed',
  detail text,
  latency_ms integer,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (surface, provider)
);

GRANT SELECT ON public.market_surface_probes TO authenticated;
GRANT ALL ON public.market_surface_probes TO service_role;

ALTER TABLE public.market_surface_probes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read surface probes"
ON public.market_surface_probes FOR SELECT TO authenticated USING (true);

CREATE TRIGGER update_market_surface_probes_updated_at
BEFORE UPDATE ON public.market_surface_probes
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();