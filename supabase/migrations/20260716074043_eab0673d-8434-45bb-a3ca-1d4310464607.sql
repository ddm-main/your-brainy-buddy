CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
DECLARE
  ext record;
BEGIN
  FOR ext IN
    SELECT extname
    FROM pg_extension
    WHERE extnamespace = 'public'::regnamespace
  LOOP
    BEGIN
      EXECUTE format('ALTER EXTENSION %I SET SCHEMA extensions', ext.extname);
    EXCEPTION
      WHEN feature_not_supported THEN NULL;
      WHEN insufficient_privilege THEN NULL;
      WHEN others THEN NULL;
    END;
  END LOOP;
END $$;