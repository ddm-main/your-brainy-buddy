
-- ============================================================================
-- JARVIS security hardening: user_id ownership + tight RLS on all public tables
-- Owner: msdeepakdon@gmail.com (2ff4497a-dedc-4885-98e5-435b26894275)
-- ============================================================================

DO $$
DECLARE
  owner_uid uuid := '2ff4497a-dedc-4885-98e5-435b26894275';
  tbl text;
  tables text[] := ARRAY[
    'areas','banks','credit_cards','daily_logs','decisions',
    'email_accounts','email_actions','email_attachments','emails',
    'finance_email_rules','financial_accounts','financial_goals',
    'inbox_items','jarvis_actions','jarvis_memory','jarvis_reminders',
    'loans','memories','next_actions','notes','project_updates',
    'projects','reconciliation_matches','statements','subscriptions',
    'tasks','transactions'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- 1. add user_id if missing
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE',
      tbl
    );
    -- 2. backfill nulls to owner
    EXECUTE format('UPDATE public.%I SET user_id = %L WHERE user_id IS NULL', tbl, owner_uid);
    -- 3. lock down: not null + default auth.uid()
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id SET NOT NULL', tbl);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id SET DEFAULT auth.uid()', tbl);
    -- 4. drop old permissive policy if present
    EXECUTE format('DROP POLICY IF EXISTS "single user open" ON public.%I', tbl);
    -- 5. owner-only policy
    EXECUTE format(
      'CREATE POLICY "owner rw" ON public.%I FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)',
      tbl
    );
    -- 6. revoke anon
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', tbl);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', tbl);
  END LOOP;
END $$;

-- jarvis_interactions has a different policy shape — handle explicitly
ALTER TABLE public.jarvis_interactions
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
UPDATE public.jarvis_interactions SET user_id = '2ff4497a-dedc-4885-98e5-435b26894275' WHERE user_id IS NULL;
ALTER TABLE public.jarvis_interactions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.jarvis_interactions ALTER COLUMN user_id SET DEFAULT auth.uid();
DROP POLICY IF EXISTS "single-user open read" ON public.jarvis_interactions;
DROP POLICY IF EXISTS "single-user open write" ON public.jarvis_interactions;
DROP POLICY IF EXISTS "single-user open update" ON public.jarvis_interactions;
DROP POLICY IF EXISTS "single-user open delete" ON public.jarvis_interactions;
CREATE POLICY "owner rw" ON public.jarvis_interactions FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
REVOKE ALL ON public.jarvis_interactions FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jarvis_interactions TO authenticated;
GRANT ALL ON public.jarvis_interactions TO service_role;

-- threads + messages already have correct policies; just revoke anon defensively
REVOKE ALL ON public.threads FROM anon;
REVOKE ALL ON public.messages FROM anon;

-- ============================================================================
-- Storage: owner-scoped policies on the private jarvis-vision bucket
-- Objects must be uploaded under `${uid}/...` path prefix
-- ============================================================================
DROP POLICY IF EXISTS "jarvis-vision owner read"   ON storage.objects;
DROP POLICY IF EXISTS "jarvis-vision owner write"  ON storage.objects;
DROP POLICY IF EXISTS "jarvis-vision owner update" ON storage.objects;
DROP POLICY IF EXISTS "jarvis-vision owner delete" ON storage.objects;

CREATE POLICY "jarvis-vision owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'jarvis-vision' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "jarvis-vision owner write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'jarvis-vision' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "jarvis-vision owner update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'jarvis-vision' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "jarvis-vision owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'jarvis-vision' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================================
-- Retention: auto-purge jarvis_interactions older than 90 days
-- (invoked by client/edge periodically; no pg_cron dependency)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.purge_old_jarvis_interactions()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.jarvis_interactions WHERE created_at < now() - interval '90 days';
$$;
