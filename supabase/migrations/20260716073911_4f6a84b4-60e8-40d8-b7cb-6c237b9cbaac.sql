DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp' AND extnamespace = 'public'::regnamespace) THEN
    CREATE SCHEMA IF NOT EXISTS extensions;
    ALTER EXTENSION "uuid-ossp" SET SCHEMA extensions;
  END IF;
END $$;