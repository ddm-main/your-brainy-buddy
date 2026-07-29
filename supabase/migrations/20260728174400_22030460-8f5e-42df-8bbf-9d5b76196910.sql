
CREATE OR REPLACE FUNCTION public.quota_report()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'db_limit_bytes', (500::bigint * 1024 * 1024),
    'storage_bytes', COALESCE((
      SELECT SUM((o.metadata->>'size')::bigint) FROM storage.objects o
    ), 0),
    'storage_limit_bytes', (1024::bigint * 1024 * 1024),
    'egress_limit_bytes', (5::bigint * 1024 * 1024 * 1024),
    'buckets', COALESCE((
      SELECT jsonb_agg(b) FROM (
        SELECT o.bucket_id AS name, COUNT(*) AS objects,
               COALESCE(SUM((o.metadata->>'size')::bigint), 0) AS bytes
        FROM storage.objects o GROUP BY o.bucket_id ORDER BY 3 DESC
      ) b
    ), '[]'::jsonb),
    'tables', COALESCE((
      SELECT jsonb_agg(t) FROM (
        SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','m')
        ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10
      ) t
    ), '[]'::jsonb),
    'quota', COALESCE((SELECT to_jsonb(q) FROM public.system_quota_state q LIMIT 1), '{}'::jsonb)
  )
$function$;

GRANT EXECUTE ON FUNCTION public.quota_report() TO authenticated;
