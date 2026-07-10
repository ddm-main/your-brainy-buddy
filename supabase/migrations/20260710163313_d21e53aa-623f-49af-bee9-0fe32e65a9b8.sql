REVOKE EXECUTE ON FUNCTION public.block_new_signups() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_old_jarvis_interactions() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_jarvis_usage(uuid, integer, bigint) FROM anon, authenticated, PUBLIC;