
-- 1. Archive index -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_archive_index (
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  object_path text NOT NULL,
  first_date date,
  last_date date,
  bars integer NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0,
  archived_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, exchange)
);

GRANT SELECT ON public.market_archive_index TO authenticated;
GRANT ALL ON public.market_archive_index TO service_role;
ALTER TABLE public.market_archive_index ENABLE ROW LEVEL SECURITY;

CREATE POLICY "archive index readable by authenticated"
  ON public.market_archive_index FOR SELECT TO authenticated USING (true);

DROP TRIGGER IF EXISTS trg_market_archive_index_updated ON public.market_archive_index;
CREATE TRIGGER trg_market_archive_index_updated
  BEFORE UPDATE ON public.market_archive_index
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Quota state --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.system_quota_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  db_bytes bigint NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  egress_bytes bigint NOT NULL DEFAULT 0,
  low_bandwidth boolean NOT NULL DEFAULT false,
  last_level text NOT NULL DEFAULT 'ok',
  checked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.system_quota_state TO authenticated;
GRANT ALL ON public.system_quota_state TO service_role;
ALTER TABLE public.system_quota_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quota state readable by authenticated"
  ON public.system_quota_state FOR SELECT TO authenticated USING (true);
CREATE POLICY "quota state writable by admins"
  ON public.system_quota_state FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.system_quota_state (id) VALUES (true) ON CONFLICT DO NOTHING;

-- 3. Storage policies for the archive bucket ----------------------------------
DROP POLICY IF EXISTS "market archive readable by authenticated" ON storage.objects;
CREATE POLICY "market archive readable by authenticated"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'market-archive');

-- 4. Retention keys for the hot price window ----------------------------------
INSERT INTO public.system_retention_config (key, days) VALUES
  ('prices_hot_tracked', 730),
  ('prices_hot_other', 400)
ON CONFLICT (key) DO NOTHING;

-- 5. Quota report --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quota_report()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'db_limit_bytes', 500 * 1024 * 1024,
    'storage_bytes', COALESCE((
      SELECT SUM((o.metadata->>'size')::bigint) FROM storage.objects o
    ), 0),
    'storage_limit_bytes', 1024 * 1024 * 1024,
    'egress_limit_bytes', 5 * 1024 * 1024 * 1024,
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
$$;

GRANT EXECUTE ON FUNCTION public.quota_report() TO authenticated, service_role;

-- 6. Governor -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_daily_maintenance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  first jsonb;
  second jsonb := NULL;
  db_bytes bigint;
  store_bytes bigint;
  level text := 'ok';
  warn  bigint := 400 * 1024 * 1024;   -- 80% of 500 MB
  crit  bigint := 440 * 1024 * 1024;
BEGIN
  first := public.prune_old_data(false);
  db_bytes := (first ->> 'size_bytes')::bigint;

  IF db_bytes > warn THEN
    level := 'warn';
    second := public.prune_old_data(true);
    db_bytes := (second ->> 'size_bytes')::bigint;
  END IF;

  IF db_bytes > crit THEN
    level := 'critical';
    -- emergency: caches and diagnostics down to a single day
    DELETE FROM public.market_indicators_cache WHERE computed_at < now() - interval '1 day';
    DELETE FROM public.market_provider_health WHERE created_at < now() - interval '1 day';
    DELETE FROM public.market_provider_observations WHERE created_at < now() - interval '1 day';
    DELETE FROM public.market_value_audit WHERE checked_at < now() - interval '1 day';
    db_bytes := pg_database_size(current_database());
  END IF;

  SELECT COALESCE(SUM((o.metadata->>'size')::bigint), 0) INTO store_bytes FROM storage.objects o;

  UPDATE public.system_quota_state
     SET db_bytes = run_daily_maintenance.db_bytes,
         storage_bytes = store_bytes,
         last_level = level,
         low_bandwidth = (level = 'critical'),
         checked_at = now(),
         updated_at = now()
   WHERE id;

  RETURN jsonb_build_object('level', level, 'db_bytes', db_bytes,
                            'storage_bytes', store_bytes,
                            'normal', first, 'aggressive', second);
END;
$$;

-- 7. Keep churn tables from re-bloating -------------------------------------------
ALTER TABLE public.market_indicators_cache SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE public.market_provider_health SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE public.market_daily_prices SET (autovacuum_vacuum_scale_factor = 0.05);
