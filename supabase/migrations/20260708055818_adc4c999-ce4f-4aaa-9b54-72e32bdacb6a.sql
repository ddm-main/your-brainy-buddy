
-- These tables are the JARVIS personal OS backend, written/read exclusively by
-- the local HUD Node server using the service_role key (which bypasses RLS).
-- No end-user browser client should reach them. Revoke Data API grants from
-- anon/authenticated and add explicit deny policies so the scanner sees intent.

REVOKE ALL ON public.areas         FROM anon, authenticated;
REVOKE ALL ON public.daily_logs    FROM anon, authenticated;
REVOKE ALL ON public.inbox_items   FROM anon, authenticated;
REVOKE ALL ON public.memories      FROM anon, authenticated;
REVOKE ALL ON public.next_actions  FROM anon, authenticated;
REVOKE ALL ON public.projects      FROM anon, authenticated;

GRANT ALL ON public.areas         TO service_role;
GRANT ALL ON public.daily_logs    TO service_role;
GRANT ALL ON public.inbox_items   TO service_role;
GRANT ALL ON public.memories      TO service_role;
GRANT ALL ON public.next_actions  TO service_role;
GRANT ALL ON public.projects      TO service_role;

-- Explicit deny policies for anon/authenticated so intent is unambiguous.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['areas','daily_logs','inbox_items','memories','next_actions','projects'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Deny anon and authenticated" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "Deny anon and authenticated" ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
      t
    );
  END LOOP;
END $$;
