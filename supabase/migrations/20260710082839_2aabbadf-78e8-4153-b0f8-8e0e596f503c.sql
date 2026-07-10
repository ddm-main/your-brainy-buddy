
REVOKE EXECUTE ON FUNCTION public.purge_old_jarvis_interactions() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.purge_old_jarvis_interactions() TO service_role;
