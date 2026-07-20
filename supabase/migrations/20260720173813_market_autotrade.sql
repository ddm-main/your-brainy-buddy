
-- =========================================================================
-- AutoTrade — rule-based entry/exit execution against the connected broker
-- (Kotak Neo). Conditions reuse the existing screener condition shape
-- (ScreenerCondition/ScreenerGroup, see market_saved_screeners.filters) so
-- rule evaluation can reuse the same Postgrest-filter translation already
-- proven by useStockScores' `groups` param.
-- =========================================================================

-- -------------------------------------------------------------------------
-- market_positions: broker-sync now flagged by a dedicated column instead of
-- matching journal_notes text — a manually-journaled position whose note
-- happened to equal the sync marker string used to be at risk of being
-- silently swept on the next Kotak sync.
-- -------------------------------------------------------------------------
ALTER TABLE public.market_positions
  ADD COLUMN IF NOT EXISTS is_broker_synced boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS market_positions_broker_synced_idx
  ON public.market_positions (user_id, is_broker_synced) WHERE is_broker_synced;
-- Backfill: rows already tagged the old way keep being recognized once.
UPDATE public.market_positions SET is_broker_synced = true
  WHERE journal_notes = 'kotak_sync' AND closed_at IS NULL;

-- -------------------------------------------------------------------------
-- market_autotrade_settings — one row per user. `enabled` is the global kill
-- switch: nothing in market-autotrade-eval evaluates or fires while false.
-- Risk caps here are enforced server-side in the evaluator, not just in the
-- UI, since evaluation runs unattended on a cron.
-- -------------------------------------------------------------------------
CREATE TABLE public.market_autotrade_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  max_capital_per_rule numeric NOT NULL DEFAULT 10000,
  max_open_positions integer NOT NULL DEFAULT 3,
  daily_loss_limit numeric NOT NULL DEFAULT 2000,
  disabled_reason text,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_autotrade_settings TO authenticated;
GRANT ALL ON public.market_autotrade_settings TO service_role;
ALTER TABLE public.market_autotrade_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_autotrade_settings" ON public.market_autotrade_settings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_autotrade_settings_updated
  BEFORE UPDATE ON public.market_autotrade_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_autotrade_rules — entry/exit conditions stored as
-- ScreenerGroup[]-shaped jsonb (same as market_saved_screeners.filters):
-- [{ "conditions": [{ "column": "rsi14", "op": "lt", "value": 30 }, ...] }]
-- Groups are OR'd, conditions within a group are AND'd — identical semantics
-- to the saved-screener model already shipped.
-- -------------------------------------------------------------------------
CREATE TABLE public.market_autotrade_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  symbol text,
  exchange text NOT NULL DEFAULT 'NSE',
  watchlist_id uuid REFERENCES public.market_watchlists(id) ON DELETE SET NULL,
  entry_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  exit_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  stop_loss_pct numeric,
  target_pct numeric,
  product text NOT NULL DEFAULT 'MIS' CHECK (product IN ('MIS','CNC')),
  order_type text NOT NULL DEFAULT 'MARKET' CHECK (order_type IN ('MARKET','LIMIT')),
  limit_offset_pct numeric,
  sizing_mode text NOT NULL DEFAULT 'fixed_capital' CHECK (sizing_mode IN ('fixed_qty','fixed_capital')),
  sizing_value numeric NOT NULL,
  is_armed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (symbol IS NOT NULL OR watchlist_id IS NOT NULL)
);
CREATE INDEX idx_market_autotrade_rules_user ON public.market_autotrade_rules (user_id);
CREATE INDEX idx_market_autotrade_rules_armed ON public.market_autotrade_rules (user_id, is_armed) WHERE is_armed;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_autotrade_rules TO authenticated;
GRANT ALL ON public.market_autotrade_rules TO service_role;
ALTER TABLE public.market_autotrade_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_autotrade_rules" ON public.market_autotrade_rules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_autotrade_rules_updated
  BEFORE UPDATE ON public.market_autotrade_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_autotrade_orders — source of truth for "is this symbol currently an
-- open AutoTrade position." Positions.tsx and market-sync-positions should
-- cross-reference this rather than any string-matched journal_notes.
-- -------------------------------------------------------------------------
CREATE TABLE public.market_autotrade_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  rule_id uuid REFERENCES public.market_autotrade_rules(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  side text NOT NULL CHECK (side IN ('BUY','SELL')),
  leg text NOT NULL CHECK (leg IN ('entry','exit')),
  quantity numeric NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('MARKET','LIMIT')),
  product text NOT NULL CHECK (product IN ('MIS','CNC')),
  requested_price numeric,
  broker_order_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','placed','filled','rejected','cancelled')),
  reason text,
  placed_at timestamptz,
  filled_at timestamptz,
  filled_price numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_market_autotrade_orders_user ON public.market_autotrade_orders (user_id, created_at DESC);
CREATE INDEX idx_market_autotrade_orders_open ON public.market_autotrade_orders (user_id, rule_id, symbol, exchange)
  WHERE status IN ('pending','placed','filled') AND leg = 'entry';
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_autotrade_orders TO authenticated;
GRANT ALL ON public.market_autotrade_orders TO service_role;
ALTER TABLE public.market_autotrade_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_autotrade_orders" ON public.market_autotrade_orders
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_autotrade_orders_updated
  BEFORE UPDATE ON public.market_autotrade_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_autotrade_log — append-only audit trail. Every eval tick, skip
-- (with reason), fire, and error gets a row. Owner SELECT+INSERT only,
-- mirroring market_alert_events — actual writes come from the cron function
-- via the service-role client, which bypasses RLS.
-- -------------------------------------------------------------------------
CREATE TABLE public.market_autotrade_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  rule_id uuid REFERENCES public.market_autotrade_rules(id) ON DELETE SET NULL,
  level text NOT NULL CHECK (level IN ('info','skip','error','fired')),
  message text NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_market_autotrade_log_user_time ON public.market_autotrade_log (user_id, created_at DESC);
GRANT SELECT, INSERT ON public.market_autotrade_log TO authenticated;
GRANT ALL ON public.market_autotrade_log TO service_role;
ALTER TABLE public.market_autotrade_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "autotrade log - owner select" ON public.market_autotrade_log
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- -------------------------------------------------------------------------
-- Cron: evaluate every minute, 03:45–10:00 UTC (≈ 09:15–15:30 IST, NSE
-- hours), weekdays only — matches marketOpen()'s window in
-- src/lib/market/hooks.ts. Reuses the existing public.market_cron_call()
-- helper (idempotent unschedule-then-schedule, same as market_autosync.sql).
-- -------------------------------------------------------------------------
SELECT cron.unschedule('market-autotrade-eval') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-autotrade-eval');
SELECT cron.schedule('market-autotrade-eval', '* 3-10 * * 1-5',
  $$SELECT public.market_cron_call('market-autotrade-eval')$$);
