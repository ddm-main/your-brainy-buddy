
-- =========================================================================
-- MARKET (Breakout Intelligence) — Phase 1 schema
-- =========================================================================

CREATE TYPE public.market_provider AS ENUM ('kotak_neo','yahoo','zerodha','dhan');
CREATE TYPE public.market_connection_status AS ENUM ('disconnected','pending_otp','connected','expired','error');
CREATE TYPE public.market_holding_source AS ENUM ('manual','kotak_sync','zerodha_sync','dhan_sync');
CREATE TYPE public.market_position_side AS ENUM ('long','short');
CREATE TYPE public.market_alert_channel AS ENUM ('browser','email','telegram','whatsapp');

-- Reusable updated_at trigger already exists as public.update_updated_at_column()

-- -------------------------------------------------------------------------
-- market_api_settings
-- -------------------------------------------------------------------------
CREATE TABLE public.market_api_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  active_provider public.market_provider NOT NULL DEFAULT 'yahoo',
  consumer_key text,
  consumer_secret_enc text,
  mobile_number_enc text,
  password_enc text,
  mpin_enc text,
  base_url text,
  ws_url text,
  exchange text DEFAULT 'NSE',
  rate_limit integer DEFAULT 10,
  access_token_enc text,
  session_token_enc text,
  view_token_enc text,
  sid text,
  hs_server_id text,
  ucc text,
  greeting_name text,
  token_expires_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  connection_status public.market_connection_status NOT NULL DEFAULT 'disconnected',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, active_provider)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_api_settings TO authenticated;
GRANT ALL ON public.market_api_settings TO service_role;
ALTER TABLE public.market_api_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_api_settings" ON public.market_api_settings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_api_settings_updated
  BEFORE UPDATE ON public.market_api_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_stocks (shared reference)
-- -------------------------------------------------------------------------
CREATE TABLE public.market_stocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  exchange text NOT NULL,
  token text,
  company_name text,
  sector text,
  industry text,
  series text,
  lot_size integer,
  isin text,
  face_value numeric,
  tick_size numeric,
  instrument_type text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, exchange)
);
CREATE INDEX idx_market_stocks_symbol ON public.market_stocks (symbol);
CREATE INDEX idx_market_stocks_token ON public.market_stocks (token) WHERE token IS NOT NULL;
GRANT SELECT ON public.market_stocks TO authenticated;
GRANT ALL ON public.market_stocks TO service_role;
ALTER TABLE public.market_stocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read market_stocks" ON public.market_stocks FOR SELECT TO authenticated USING (true);
CREATE TRIGGER trg_market_stocks_updated
  BEFORE UPDATE ON public.market_stocks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_daily_prices (shared reference)
-- -------------------------------------------------------------------------
CREATE TABLE public.market_daily_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  exchange text NOT NULL,
  trade_date date NOT NULL,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume bigint,
  delivery_qty bigint,
  delivery_pct numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, exchange, trade_date)
);
CREATE INDEX idx_market_daily_prices_symbol_date ON public.market_daily_prices (symbol, trade_date DESC);
GRANT SELECT ON public.market_daily_prices TO authenticated;
GRANT ALL ON public.market_daily_prices TO service_role;
ALTER TABLE public.market_daily_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read market_daily_prices" ON public.market_daily_prices FOR SELECT TO authenticated USING (true);

-- -------------------------------------------------------------------------
-- market_intraday_prices (shared reference, short retention)
-- -------------------------------------------------------------------------
CREATE TABLE public.market_intraday_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  exchange text NOT NULL,
  ts timestamptz NOT NULL,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, exchange, ts)
);
CREATE INDEX idx_market_intraday_symbol_ts ON public.market_intraday_prices (symbol, ts DESC);
GRANT SELECT ON public.market_intraday_prices TO authenticated;
GRANT ALL ON public.market_intraday_prices TO service_role;
ALTER TABLE public.market_intraday_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read market_intraday" ON public.market_intraday_prices FOR SELECT TO authenticated USING (true);

-- -------------------------------------------------------------------------
-- market_holdings
-- -------------------------------------------------------------------------
CREATE TABLE public.market_holdings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  quantity numeric NOT NULL,
  avg_price numeric NOT NULL,
  buy_date date,
  investment_type text,
  notes text,
  source public.market_holding_source NOT NULL DEFAULT 'manual',
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_market_holdings_user ON public.market_holdings (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_holdings TO authenticated;
GRANT ALL ON public.market_holdings TO service_role;
ALTER TABLE public.market_holdings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_holdings" ON public.market_holdings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_holdings_updated
  BEFORE UPDATE ON public.market_holdings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_positions
-- -------------------------------------------------------------------------
CREATE TABLE public.market_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  side public.market_position_side NOT NULL DEFAULT 'long',
  quantity numeric NOT NULL,
  entry_price numeric NOT NULL,
  stop_loss numeric,
  target numeric,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  exit_price numeric,
  pnl numeric,
  trailing_stop numeric,
  journal_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_market_positions_user ON public.market_positions (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_positions TO authenticated;
GRANT ALL ON public.market_positions TO service_role;
ALTER TABLE public.market_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_positions" ON public.market_positions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_positions_updated
  BEFORE UPDATE ON public.market_positions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_watchlists + items
-- -------------------------------------------------------------------------
CREATE TABLE public.market_watchlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  color text,
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_watchlists TO authenticated;
GRANT ALL ON public.market_watchlists TO service_role;
ALTER TABLE public.market_watchlists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_watchlists" ON public.market_watchlists
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_watchlists_updated
  BEFORE UPDATE ON public.market_watchlists
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.market_watchlist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  watchlist_id uuid NOT NULL REFERENCES public.market_watchlists(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  color text,
  priority integer DEFAULT 0,
  notes text,
  tags text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (watchlist_id, symbol, exchange)
);
CREATE INDEX idx_market_watchlist_items_user ON public.market_watchlist_items (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_watchlist_items TO authenticated;
GRANT ALL ON public.market_watchlist_items TO service_role;
ALTER TABLE public.market_watchlist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_watchlist_items" ON public.market_watchlist_items
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_watchlist_items_updated
  BEFORE UPDATE ON public.market_watchlist_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_alerts
-- -------------------------------------------------------------------------
CREATE TABLE public.market_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  alert_type text NOT NULL,
  threshold numeric,
  config jsonb,
  channel public.market_alert_channel NOT NULL DEFAULT 'browser',
  is_active boolean NOT NULL DEFAULT true,
  triggered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_market_alerts_user ON public.market_alerts (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_alerts TO authenticated;
GRANT ALL ON public.market_alerts TO service_role;
ALTER TABLE public.market_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_alerts" ON public.market_alerts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_alerts_updated
  BEFORE UPDATE ON public.market_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_saved_screeners
-- -------------------------------------------------------------------------
CREATE TABLE public.market_saved_screeners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  filters jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_saved_screeners TO authenticated;
GRANT ALL ON public.market_saved_screeners TO service_role;
ALTER TABLE public.market_saved_screeners ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_saved_screeners" ON public.market_saved_screeners
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_saved_screeners_updated
  BEFORE UPDATE ON public.market_saved_screeners
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_saved_strategies + backtest results
-- -------------------------------------------------------------------------
CREATE TABLE public.market_saved_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  strategy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_saved_strategies TO authenticated;
GRANT ALL ON public.market_saved_strategies TO service_role;
ALTER TABLE public.market_saved_strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_saved_strategies" ON public.market_saved_strategies
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_saved_strategies_updated
  BEFORE UPDATE ON public.market_saved_strategies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.market_backtest_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  strategy_id uuid REFERENCES public.market_saved_strategies(id) ON DELETE CASCADE,
  period_years integer,
  metrics jsonb,
  equity_curve jsonb,
  trades jsonb,
  ran_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_market_backtest_user ON public.market_backtest_results (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_backtest_results TO authenticated;
GRANT ALL ON public.market_backtest_results TO service_role;
ALTER TABLE public.market_backtest_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_backtest_results" ON public.market_backtest_results
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- -------------------------------------------------------------------------
-- market_portfolio_notes
-- -------------------------------------------------------------------------
CREATE TABLE public.market_portfolio_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_market_portfolio_notes_user_symbol ON public.market_portfolio_notes (user_id, symbol);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_portfolio_notes TO authenticated;
GRANT ALL ON public.market_portfolio_notes TO service_role;
ALTER TABLE public.market_portfolio_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_portfolio_notes" ON public.market_portfolio_notes
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_portfolio_notes_updated
  BEFORE UPDATE ON public.market_portfolio_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -------------------------------------------------------------------------
-- market_indicators_cache
-- -------------------------------------------------------------------------
CREATE TABLE public.market_indicators_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  timeframe text NOT NULL,
  indicator text NOT NULL,
  value jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, exchange, timeframe, indicator)
);
CREATE INDEX idx_market_indicators_lookup ON public.market_indicators_cache (symbol, timeframe, indicator);
GRANT SELECT ON public.market_indicators_cache TO authenticated;
GRANT ALL ON public.market_indicators_cache TO service_role;
ALTER TABLE public.market_indicators_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read market_indicators_cache" ON public.market_indicators_cache FOR SELECT TO authenticated USING (true);

-- -------------------------------------------------------------------------
-- market_user_prefs
-- -------------------------------------------------------------------------
CREATE TABLE public.market_user_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  theme text DEFAULT 'dark',
  default_timeframe text DEFAULT '1D',
  default_risk_pct numeric DEFAULT 1.0,
  brokerage_pct numeric DEFAULT 0.03,
  slippage_pct numeric DEFAULT 0.05,
  portfolio_size numeric,
  refresh_seconds integer DEFAULT 15,
  notification_prefs jsonb DEFAULT '{"browser":true,"email":false}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_user_prefs TO authenticated;
GRANT ALL ON public.market_user_prefs TO service_role;
ALTER TABLE public.market_user_prefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_user_prefs" ON public.market_user_prefs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_market_user_prefs_updated
  BEFORE UPDATE ON public.market_user_prefs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
