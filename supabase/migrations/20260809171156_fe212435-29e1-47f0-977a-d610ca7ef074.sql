ALTER TABLE public.market_surface_probes
  ADD COLUMN IF NOT EXISTS plane text NOT NULL DEFAULT 'data';

DELETE FROM public.market_surface_probes
 WHERE surface IN ('funds','holdings','positions') AND plane = 'data';

ALTER TABLE public.market_surface_probes
  DROP CONSTRAINT IF EXISTS market_surface_probes_surface_provider_key;
DROP INDEX IF EXISTS public.market_surface_probes_surface_provider_key;

CREATE UNIQUE INDEX IF NOT EXISTS market_surface_probes_surface_provider_plane_key
  ON public.market_surface_probes (surface, provider, plane);