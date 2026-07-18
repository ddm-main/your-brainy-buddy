
REVOKE EXECUTE ON FUNCTION public.seed_default_indices(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_default_indices(uuid) TO service_role;
