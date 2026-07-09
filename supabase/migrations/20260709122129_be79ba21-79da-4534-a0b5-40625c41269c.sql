DROP POLICY IF EXISTS "Open access for personal OS" ON public.jarvis_memory;
DROP POLICY IF EXISTS "Open access for personal OS" ON public.jarvis_reminders;

REVOKE ALL ON public.jarvis_memory FROM anon, authenticated;
REVOKE ALL ON public.jarvis_reminders FROM anon, authenticated;

GRANT ALL ON public.jarvis_memory TO service_role;
GRANT ALL ON public.jarvis_reminders TO service_role;