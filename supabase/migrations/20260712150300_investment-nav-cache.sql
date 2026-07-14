-- Deliberate deviation from the owner-scoped RLS pattern used everywhere
-- else in this schema: NAV data from AMFI's public feed is scheme-level
-- reference data, not user data — there is nothing to scope per-user, and
-- caching one shared copy (instead of one per user) avoids redundant
-- fetches/storage. Every authenticated user may read it; only the
-- finance-sync-nav edge function (service_role) may write it.

CREATE TABLE IF NOT EXISTS public.investment_nav_cache (
  scheme_code text PRIMARY KEY,
  scheme_name text NOT NULL,
  nav numeric(14,4) NOT NULL,
  nav_date date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.investment_nav_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated read" ON public.investment_nav_cache
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.investment_nav_cache FROM anon;
GRANT SELECT ON public.investment_nav_cache TO authenticated;
GRANT ALL ON public.investment_nav_cache TO service_role;
