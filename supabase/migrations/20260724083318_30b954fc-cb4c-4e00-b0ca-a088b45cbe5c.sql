
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_section_access(uuid, public.app_section) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.assign_default_role_and_access() FROM PUBLIC, anon, authenticated;
