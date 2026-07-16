CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
DECLARE
  ext text;
BEGIN
  FOREACH ext IN ARRAY ARRAY['uuid-ossp', 'pgcrypto', 'pgjwt', 'http']
  LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = ext AND extnamespace = 'public'::regnamespace) THEN
        EXECUTE format('ALTER EXTENSION %I SET SCHEMA extensions', ext);
      END IF;
    EXCEPTION WHEN feature_not_supported THEN
      NULL;
    END;
  END LOOP;
END $$;