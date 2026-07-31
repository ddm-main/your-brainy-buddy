-- 1) Views: enforce querying user's permissions
ALTER VIEW public.market_score_band_stats SET (security_invoker = on);

-- 2) Revoke anon EXECUTE on SECURITY DEFINER functions
REVOKE EXECUTE ON FUNCTION public.market_feed_freshness() FROM anon;
REVOKE EXECUTE ON FUNCTION public.score_history_coverage(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.market_score_cohort(text, integer, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.market_score_cohort(text, integer, numeric, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.market_score_cohort_symbols(text, integer, numeric, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.market_score_cohort_symbols(text, integer, numeric, integer, text) FROM anon;

-- 3) Simplify role-check helpers to straightforward lookups
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$function$;

CREATE OR REPLACE FUNCTION public.has_section_access(_user_id uuid, _section app_section)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = 'admin')
      OR EXISTS (SELECT 1 FROM public.user_page_access WHERE user_id = _user_id AND section = _section)
$function$;

-- 4) Defense-in-depth owner default
ALTER TABLE public.market_feed_prefs ALTER COLUMN user_id SET DEFAULT auth.uid();

-- 5) Market metric consensus: general read for signed-in users
DROP POLICY IF EXISTS "read market metric consensus" ON public.market_metric_consensus;
CREATE POLICY "read market metric consensus"
ON public.market_metric_consensus
FOR SELECT
TO authenticated
USING (true);