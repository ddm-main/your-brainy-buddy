CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector' AND extnamespace = 'public'::regnamespace) THEN
    BEGIN
      ALTER EXTENSION vector SET SCHEMA extensions;
    EXCEPTION WHEN feature_not_supported THEN
      NULL;
    END;
  END IF;
END $$;