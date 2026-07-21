
-- =========================================================================
-- Close the genuine gaps against the proposed production architecture:
-- news, corporate actions/earnings calendar, trading holidays, portfolio
-- value history, and lightweight provider-health/anomaly logging. All
-- sourced from providers already integrated (Kotak, Yahoo, NSE) — no new
-- paid APIs, no table renames.
--
-- Made idempotent in place (rather than only in a later follow-up
-- migration) after discovering this exact file was the actual root cause
-- of a much bigger outage: 20260713101258_...sql already created
-- public.market_news with an OLD shape (no `symbol` column). This file's
-- original `CREATE TABLE public.market_news` (no IF NOT EXISTS, new
-- incompatible shape) hit "relation already exists" on any database where
-- the July 13 migration had already landed — aborting this file's entire
-- migration transaction and silently taking market_corporate_actions,
-- market_holidays, market_portfolio_snapshots, and market_provider_health
-- down with it. Since migration runners apply files in order and stop at
-- the first failure, EVERY migration timestamped after this one —
-- including 20260721000000_market_multi_provider.sql (public.market_data)
-- — never had a chance to apply either. A later migration
-- (20260721010000_fix_market_news_schema_conflict.sql) was written to
-- "self-heal" this, but a migration that runs *after* a permanently-
-- failing one in the same sequence never gets reached — the fix has to
-- live here, at the source.
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

-- -------------------------------------------------------------------------
-- market_news — shared reference (same headlines for every user watching a
-- symbol), synced on demand for watchlist/holding symbols, not the full
-- universe.
-- -------------------------------------------------------------------------
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

-- -------------------------------------------------------------------------
-- market_corporate_actions — dividends, splits, bonuses, board meetings,
-- results dates. Shared reference, synced daily from NSE.
-- -------------------------------------------------------------------------
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

-- -------------------------------------------------------------------------
-- market_holidays — NSE trading holidays. Low-churn (known months ahead,
-- changes yearly), synced manually/annually rather than a live pipeline.
-- -------------------------------------------------------------------------
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

-- -------------------------------------------------------------------------
-- market_portfolio_snapshots — one row per user per day, computed from
-- market_holdings once the EOD pipeline lands. Owner-scoped, personal data.
-- -------------------------------------------------------------------------
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

-- -------------------------------------------------------------------------
-- market_provider_health — lightweight success/failure/latency log per
-- provider call, plus reused for price-outlier-guard anomaly entries
-- (ok=false, error='outlier: ...'). Append-only, shared visibility (no
-- per-user data in it), written only by service_role.
-- -------------------------------------------------------------------------
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
-- Keep this table from growing unbounded — trim to the last 14 days on each
-- insert-heavy pass is overkill; a weekly prune via the existing Saturday
-- scrips-sync cron window is enough for a log table at this volume.

-- -------------------------------------------------------------------------
-- Cron: corporate actions daily (after EOD, before next session); holidays
-- monthly (NSE typically publishes next year's list in December — a monthly
-- check is cheap and doesn't need exact annual timing). News stays on-demand
-- only (per-symbol RSS fetch, triggered from the UI), not cron'd.
-- -------------------------------------------------------------------------
SELECT cron.unschedule('market-corporate-actions-sync') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-corporate-actions-sync');
SELECT cron.schedule('market-corporate-actions-sync', '0 15 * * 1-5',
  $$SELECT public.market_cron_call('market-corporate-actions-sync')$$);

SELECT cron.unschedule('market-holidays-sync') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-holidays-sync');
SELECT cron.schedule('market-holidays-sync', '0 4 1 * *',
  $$SELECT public.market_cron_call('market-holidays-sync')$$);
