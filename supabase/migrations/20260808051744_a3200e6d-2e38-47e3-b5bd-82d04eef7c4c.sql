-- Restore Data API grants lost in the backup/restore. RLS (already enabled on
-- every public table, 134 policies) remains the row-level authority; these
-- grants are what makes PostgREST able to reach the tables at all.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

DO $$
DECLARE r record;
BEGIN
  -- Base tables
  FOR r IN SELECT c.relname
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', r.relname);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', r.relname);
  END LOOP;

  -- Views and materialized views
  FOR r IN SELECT c.relname
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', r.relname);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', r.relname);
  END LOOP;

  -- Sequences
  FOR r IN SELECT c.relname
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'S'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO authenticated', r.relname);
    EXECUTE format('GRANT ALL ON SEQUENCE public.%I TO service_role', r.relname);
  END LOOP;
END $$;

-- Functions / RPCs the client and edge functions call.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;

-- Anonymous read: only the two datasets whose SELECT policy is public.
GRANT SELECT ON public.market_screener_snapshot TO anon;
GRANT SELECT ON public.market_sector_map TO anon;

-- Keep future objects reachable without another restore-style outage.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;