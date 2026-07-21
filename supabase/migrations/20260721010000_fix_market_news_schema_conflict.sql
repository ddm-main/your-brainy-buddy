-- =========================================================================
-- Reconcile a schema conflict between two earlier migrations:
--   20260713101258_...sql created public.market_news with an OLD shape
--     (id, headline, url, source, published_at, created_at — no symbol).
--   20260720184357_market_data_gaps.sql did `CREATE TABLE public.market_news`
--     (no IF NOT EXISTS) with a NEW, incompatible shape (adds symbol,
--     exchange, UNIQUE(symbol,exchange,url)) that market-news-sync/index.ts
--     actually writes today.
--
-- On a database where the July 13 migration already landed, that July 20
-- CREATE TABLE fails with "relation already exists" and aborts the whole
-- migration transaction — silently taking market_corporate_actions,
-- market_holidays, market_portfolio_snapshots, and market_provider_health
-- down with it too (all defined later in that same file), and leaving the
-- corporate-actions/holidays sync cron schedules never installed.
--
-- This migration is self-healing regardless of which of the above states
-- the target database is actually in: fixes market_news's shape if it's
-- stuck on the old one (disposable on-demand cache data per its own
-- docstring — safe to drop and recreate rather than migrate rows), then
-- recreates every table/policy/cron job from the July 20 migration with
-- IF NOT EXISTS / idempotent guards so it's a no-op wherever that already
-- landed successfully, and a safety net wherever it didn't.
-- =========================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'market_news'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'market_news' AND column_name = 'symbol'
  ) THEN
    DROP TABLE public.market_news;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.market_news (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  headline text NOT NULL,
  url text,
  source text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, exchange, url)
);
CREATE INDEX IF NOT EXISTS idx_market_news_symbol ON public.market_news (symbol, exchange, published_at DESC);
GRANT SELECT ON public.market_news TO authenticated, anon;
GRANT ALL ON public.market_news TO service_role;
ALTER TABLE public.market_news ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read market_news" ON public.market_news;
CREATE POLICY "read market_news" ON public.market_news FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS public.market_corporate_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  action_type text NOT NULL CHECK (action_type IN ('dividend','split','bonus','results','board_meeting','other')),
  ex_date date,
  record_date date,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, exchange, action_type, ex_date)
);
CREATE INDEX IF NOT EXISTS idx_market_corp_actions_symbol ON public.market_corporate_actions (symbol, exchange, ex_date DESC);
GRANT SELECT ON public.market_corporate_actions TO authenticated, anon;
GRANT ALL ON public.market_corporate_actions TO service_role;
ALTER TABLE public.market_corporate_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read market_corporate_actions" ON public.market_corporate_actions;
CREATE POLICY "read market_corporate_actions" ON public.market_corporate_actions FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS public.market_holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date date NOT NULL,
  description text,
  exchange text NOT NULL DEFAULT 'NSE',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (holiday_date, exchange)
);
CREATE INDEX IF NOT EXISTS idx_market_holidays_date ON public.market_holidays (holiday_date);
GRANT SELECT ON public.market_holidays TO authenticated, anon;
GRANT ALL ON public.market_holidays TO service_role;
ALTER TABLE public.market_holidays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read market_holidays" ON public.market_holidays;
CREATE POLICY "read market_holidays" ON public.market_holidays FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS public.market_portfolio_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  snapshot_date date NOT NULL,
  total_value numeric,
  total_invested numeric,
  total_pnl numeric,
  unresolved_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_market_portfolio_snapshots_user ON public.market_portfolio_snapshots (user_id, snapshot_date DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_portfolio_snapshots TO authenticated;
GRANT ALL ON public.market_portfolio_snapshots TO service_role;
ALTER TABLE public.market_portfolio_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own market_portfolio_snapshots" ON public.market_portfolio_snapshots;
CREATE POLICY "own market_portfolio_snapshots" ON public.market_portfolio_snapshots
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.market_provider_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  endpoint text NOT NULL,
  ok boolean NOT NULL,
  latency_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_provider_health_time ON public.market_provider_health (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_provider_health_provider ON public.market_provider_health (provider, created_at DESC);
GRANT SELECT ON public.market_provider_health TO authenticated;
GRANT ALL ON public.market_provider_health TO service_role;
ALTER TABLE public.market_provider_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read market_provider_health" ON public.market_provider_health;
CREATE POLICY "read market_provider_health" ON public.market_provider_health FOR SELECT TO authenticated USING (true);

-- Re-affirm the cron jobs in case the aborted transaction never installed them.
SELECT cron.unschedule('market-corporate-actions-sync') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-corporate-actions-sync');
SELECT cron.schedule('market-corporate-actions-sync', '0 15 * * 1-5',
  $$SELECT public.market_cron_call('market-corporate-actions-sync')$$);

SELECT cron.unschedule('market-holidays-sync') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-holidays-sync');
SELECT cron.schedule('market-holidays-sync', '0 4 1 * *',
  $$SELECT public.market_cron_call('market-holidays-sync')$$);
