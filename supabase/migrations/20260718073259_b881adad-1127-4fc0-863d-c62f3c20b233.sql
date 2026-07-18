
-- 1. fii_dii_activity: add segment + gross columns
ALTER TABLE public.fii_dii_activity
  ADD COLUMN IF NOT EXISTS segment text NOT NULL DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS fii_gross_buy numeric,
  ADD COLUMN IF NOT EXISTS fii_gross_sell numeric,
  ADD COLUMN IF NOT EXISTS dii_gross_buy numeric,
  ADD COLUMN IF NOT EXISTS dii_gross_sell numeric,
  ADD COLUMN IF NOT EXISTS net_buy_inr_cr numeric;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fii_dii_activity_date_segment_key') THEN
    ALTER TABLE public.fii_dii_activity ADD CONSTRAINT fii_dii_activity_date_segment_key UNIQUE (activity_date, segment);
  END IF;
END $$;

-- 2. market_breadth_daily: add VIX, FII/DII net, new highs/lows, market_score
ALTER TABLE public.market_breadth_daily
  ADD COLUMN IF NOT EXISTS india_vix numeric,
  ADD COLUMN IF NOT EXISTS fii_net_cr numeric,
  ADD COLUMN IF NOT EXISTS dii_net_cr numeric,
  ADD COLUMN IF NOT EXISTS new_highs integer,
  ADD COLUMN IF NOT EXISTS new_lows integer,
  ADD COLUMN IF NOT EXISTS market_score numeric;

-- 3. market_stock_scores: add advanced indicator columns
ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS vwap numeric,
  ADD COLUMN IF NOT EXISTS supertrend numeric,
  ADD COLUMN IF NOT EXISTS supertrend_dir smallint,
  ADD COLUMN IF NOT EXISTS obv numeric,
  ADD COLUMN IF NOT EXISTS mfi14 numeric,
  ADD COLUMN IF NOT EXISTS bb_percent_b numeric,
  ADD COLUMN IF NOT EXISTS pattern_flags jsonb;

-- 4. market_fundamentals: add typed financial columns
ALTER TABLE public.market_fundamentals
  ADD COLUMN IF NOT EXISTS pe numeric,
  ADD COLUMN IF NOT EXISTS pb numeric,
  ADD COLUMN IF NOT EXISTS roe numeric,
  ADD COLUMN IF NOT EXISTS roce numeric,
  ADD COLUMN IF NOT EXISTS debt_to_equity numeric,
  ADD COLUMN IF NOT EXISTS market_cap_cr numeric,
  ADD COLUMN IF NOT EXISTS dividend_yield numeric,
  ADD COLUMN IF NOT EXISTS eps_ttm numeric,
  ADD COLUMN IF NOT EXISTS sector text,
  ADD COLUMN IF NOT EXISTS industry text;

-- 5. market_stocks: is_nifty500 flag + index
ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS is_nifty500 boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS market_stocks_symbol_ex_idx ON public.market_stocks(symbol, exchange);
CREATE INDEX IF NOT EXISTS market_stocks_is_nifty500_idx ON public.market_stocks(is_nifty500) WHERE is_nifty500;

-- 6. market_stock_ai: add typed recommendation columns
ALTER TABLE public.market_stock_ai
  ADD COLUMN IF NOT EXISTS entry_price numeric,
  ADD COLUMN IF NOT EXISTS stop_loss numeric,
  ADD COLUMN IF NOT EXISTS targets numeric[],
  ADD COLUMN IF NOT EXISTS holding_period_days integer,
  ADD COLUMN IF NOT EXISTS risk_level text,
  ADD COLUMN IF NOT EXISTS recommendation text,
  ADD COLUMN IF NOT EXISTS confidence numeric,
  ADD COLUMN IF NOT EXISTS rationale text,
  ADD COLUMN IF NOT EXISTS score_hash text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'market_stock_ai_rec_check') THEN
    ALTER TABLE public.market_stock_ai ADD CONSTRAINT market_stock_ai_rec_check
      CHECK (recommendation IS NULL OR recommendation IN ('Buy','Hold','Wait','Avoid'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS market_stock_ai_symbol_idx ON public.market_stock_ai(symbol, exchange);
CREATE INDEX IF NOT EXISTS market_stock_ai_hash_idx ON public.market_stock_ai(score_hash);

-- 7. market_user_prefs: add settings columns
ALTER TABLE public.market_user_prefs
  ADD COLUMN IF NOT EXISTS theme text DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS refresh_seconds integer DEFAULT 30,
  ADD COLUMN IF NOT EXISTS default_timeframe text DEFAULT '1D',
  ADD COLUMN IF NOT EXISTS default_risk_pct numeric DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS notify_browser boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_email boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_telegram boolean DEFAULT false;

-- 8. NEW: market_alert_events
CREATE TABLE IF NOT EXISTS public.market_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES public.market_alerts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  triggered_at timestamptz NOT NULL DEFAULT now(),
  trigger_value numeric,
  channel text,
  delivered_at timestamptz,
  error text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.market_alert_events TO authenticated;
GRANT ALL ON public.market_alert_events TO service_role;
ALTER TABLE public.market_alert_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alert events - owner select" ON public.market_alert_events
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS market_alert_events_user_time_idx
  ON public.market_alert_events(user_id, triggered_at DESC);

-- 9. NEW: push_subscriptions
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  ua text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "push subs - owner all" ON public.push_subscriptions
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER push_subscriptions_touch BEFORE UPDATE ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
