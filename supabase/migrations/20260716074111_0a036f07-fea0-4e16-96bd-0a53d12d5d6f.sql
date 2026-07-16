CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm' AND extnamespace = 'public'::regnamespace) THEN
    BEGIN
      ALTER EXTENSION pg_trgm SET SCHEMA extensions;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END IF;
END $$;