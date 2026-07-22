-- ============ market_autotrade_settings ============
CREATE TABLE IF NOT EXISTS public.market_autotrade_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  max_capital_per_rule numeric NOT NULL DEFAULT 10000,
  max_open_positions integer NOT NULL DEFAULT 3,
  daily_loss_limit numeric NOT NULL DEFAULT 2000,
  disabled_reason text,
  disabled_at timestamptz,
  eval_lock_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_autotrade_settings TO authenticated;
GRANT ALL ON public.market_autotrade_settings TO service_role;
ALTER TABLE public.market_autotrade_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own autotrade settings" ON public.market_autotrade_settings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============ market_autotrade_rules ============
CREATE TABLE IF NOT EXISTS public.market_autotrade_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  symbol text,
  exchange text NOT NULL DEFAULT 'NSE',
  watchlist_id uuid,
  entry_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  exit_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  stop_loss_pct numeric,
  target_pct numeric,
  product text NOT NULL DEFAULT 'MIS' CHECK (product IN ('MIS','CNC','NRML')),
  order_type text NOT NULL DEFAULT 'MARKET' CHECK (order_type IN ('MARKET','LIMIT')),
  limit_offset_pct numeric,
  sizing_mode text NOT NULL DEFAULT 'fixed_capital' CHECK (sizing_mode IN ('fixed_qty','fixed_capital')),
  sizing_value numeric NOT NULL DEFAULT 10000,
  is_armed boolean NOT NULL DEFAULT false,
  exit_order_type text NOT NULL DEFAULT 'MARKET' CHECK (exit_order_type IN ('MARKET','LIMIT','SL','SL-M')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_autotrade_rules_user ON public.market_autotrade_rules(user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_autotrade_rules TO authenticated;
GRANT ALL ON public.market_autotrade_rules TO service_role;
ALTER TABLE public.market_autotrade_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own autotrade rules" ON public.market_autotrade_rules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============ market_autotrade_orders ============
CREATE TABLE IF NOT EXISTS public.market_autotrade_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.market_autotrade_rules(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  side text NOT NULL CHECK (side IN ('BUY','SELL')),
  leg text NOT NULL CHECK (leg IN ('entry','exit')),
  quantity numeric NOT NULL,
  order_type text NOT NULL DEFAULT 'MARKET',
  product text NOT NULL DEFAULT 'MIS',
  requested_price numeric,
  filled_price numeric,
  filled_at timestamptz,
  broker_order_id text,
  broker_sl_order_id text,
  last_broker_sync_at timestamptz,
  status text NOT NULL DEFAULT 'placed',
  reason text,
  placed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_autotrade_orders_user ON public.market_autotrade_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_autotrade_orders_broker
  ON public.market_autotrade_orders(broker_order_id) WHERE broker_order_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_autotrade_orders TO authenticated;
GRANT ALL ON public.market_autotrade_orders TO service_role;
ALTER TABLE public.market_autotrade_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own autotrade orders" ON public.market_autotrade_orders
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============ market_autotrade_log ============
CREATE TABLE IF NOT EXISTS public.market_autotrade_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.market_autotrade_rules(id) ON DELETE SET NULL,
  level text NOT NULL CHECK (level IN ('info','skip','error','fired')),
  message text NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_autotrade_log_user ON public.market_autotrade_log(user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_autotrade_log TO authenticated;
GRANT ALL ON public.market_autotrade_log TO service_role;
ALTER TABLE public.market_autotrade_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own autotrade log" ON public.market_autotrade_log
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Updated_at triggers
DROP TRIGGER IF EXISTS trg_autotrade_settings_updated ON public.market_autotrade_settings;
CREATE TRIGGER trg_autotrade_settings_updated BEFORE UPDATE ON public.market_autotrade_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS trg_autotrade_rules_updated ON public.market_autotrade_rules;
CREATE TRIGGER trg_autotrade_rules_updated BEFORE UPDATE ON public.market_autotrade_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Cron consolidation ============
DO $$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobname FROM cron.job WHERE jobname IN (
    'market-autotrade-eval','market-autotrade-fills','market-fii-dii-sync',
    'market-corporate-actions-sync','market-holidays-sync','market-news-sync',
    'market-fmp-sync','market-data-validation'
  ) LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

SELECT cron.schedule('market-autotrade-eval', '* 3-10 * * 1-5',
  $$SELECT public.market_cron_call('market-autotrade-eval')$$);
SELECT cron.schedule('market-autotrade-fills', '* 3-10 * * 1-5',
  $$SELECT public.market_cron_call('market-autotrade-fills')$$);
SELECT cron.schedule('market-fii-dii-sync', '0 12 * * 1-5',
  $$SELECT public.market_cron_call('market-fii-dii-sync')$$);
SELECT cron.schedule('market-corporate-actions-sync', '0 15 * * 1-5',
  $$SELECT public.market_cron_call('market-corporate-actions-sync')$$);
SELECT cron.schedule('market-holidays-sync', '0 4 1 * *',
  $$SELECT public.market_cron_call('market-holidays-sync')$$);
SELECT cron.schedule('market-news-sync', '*/30 3-11 * * 1-5',
  $$SELECT public.market_cron_call('market-news-sync')$$);
SELECT cron.schedule('market-fmp-sync', '30 16 * * 1-5',
  $$SELECT public.market_cron_call('market-fmp-sync')$$);
SELECT cron.schedule('market-data-validation', '0 17 * * 1-5',
  $$SELECT public.market_cron_call('market-data-validation')$$);