-- =========================================================================
-- MARKET v2 — real Kotak Neo auth, data pipeline, scoring engine, cron
-- =========================================================================

-- -------------------------------------------------------------------------
-- market_api_settings: Kotak Neo v2 TOTP-flow columns
-- -------------------------------------------------------------------------
ALTER TABLE public.market_api_settings
  ADD COLUMN IF NOT EXISTS totp_secret_enc text,
  ADD COLUMN IF NOT EXISTS rid text,
  ADD COLUMN IF NOT EXISTS data_center text;

-- -------------------------------------------------------------------------
-- market_stocks: universe + pipeline cursor
-- -------------------------------------------------------------------------
ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS in_universe boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS yahoo_symbol text,
  ADD COLUMN IF NOT EXISTS last_price_sync_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_market_stocks_universe_cursor
  ON public.market_stocks (in_universe, last_price_sync_at NULLS FIRST);

-- -------------------------------------------------------------------------
-- market_stock_scores — one wide row per symbol (screener/dashboard backbone)
-- -------------------------------------------------------------------------
CREATE TABLE public.market_stock_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  trade_date date,
  close numeric,
  change_pct numeric,
  volume bigint,
  vol_avg20 numeric,
  rel_volume numeric,
  ema20 numeric,
  ema50 numeric,
  ema100 numeric,
  ema200 numeric,
  rsi14 numeric,
  macd numeric,
  macd_signal numeric,
  macd_hist numeric,
  adx14 numeric,
  atr14 numeric,
  atr_pct numeric,
  bb_upper numeric,
  bb_lower numeric,
  bb_width numeric,
  bb_squeeze boolean,
  high_52w numeric,
  low_52w numeric,
  pct_from_52w_high numeric,
  delivery_pct numeric,
  above_ema200 boolean,
  higher_lows boolean,
  near_resistance boolean,
  resistance_level numeric,
  support_level numeric,
  sector text,
  sector_strength numeric,
  rel_strength_nifty numeric,
  breakout_score integer,
  prebreakout_score integer,
  score_components jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, exchange)
);
CREATE INDEX idx_market_stock_scores_breakout ON public.market_stock_scores (breakout_score DESC NULLS LAST);
CREATE INDEX idx_market_stock_scores_prebreakout ON public.market_stock_scores (prebreakout_score DESC NULLS LAST);
GRANT SELECT ON public.market_stock_scores TO authenticated;
GRANT ALL ON public.market_stock_scores TO service_role;
ALTER TABLE public.market_stock_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read market_stock_scores" ON public.market_stock_scores
  FOR SELECT TO authenticated USING (true);

-- -------------------------------------------------------------------------
-- market_breadth_daily
-- -------------------------------------------------------------------------
CREATE TABLE public.market_breadth_daily (
  trade_date date PRIMARY KEY,
  advances integer,
  declines integer,
  unchanged integer,
  pct_above_ema20 numeric,
  pct_above_ema50 numeric,
  pct_above_ema200 numeric,
  avg_rsi numeric,
  nifty_close numeric,
  nifty_change_pct numeric,
  regime text,
  computed jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.market_breadth_daily TO authenticated;
GRANT ALL ON public.market_breadth_daily TO service_role;
ALTER TABLE public.market_breadth_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read market_breadth_daily" ON public.market_breadth_daily
  FOR SELECT TO authenticated USING (true);

-- -------------------------------------------------------------------------
-- market_sector_strength_daily
-- -------------------------------------------------------------------------
CREATE TABLE public.market_sector_strength_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_date date NOT NULL,
  sector text NOT NULL,
  stock_count integer,
  avg_change_pct numeric,
  avg_rsi numeric,
  pct_above_ema50 numeric,
  strength_rank integer,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_date, sector)
);
CREATE INDEX idx_market_sector_strength_date ON public.market_sector_strength_daily (trade_date DESC);
GRANT SELECT ON public.market_sector_strength_daily TO authenticated;
GRANT ALL ON public.market_sector_strength_daily TO service_role;
ALTER TABLE public.market_sector_strength_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read market_sector_strength" ON public.market_sector_strength_daily
  FOR SELECT TO authenticated USING (true);

-- -------------------------------------------------------------------------
-- Cron: pg_cron + pg_net calling edge functions with a Vault-held secret
-- -------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- One-time cron secret in Vault (kept if it already exists)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'market_cron_secret') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(24), 'hex'), 'market_cron_secret');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.market_cron_call(fn_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  secret text;
BEGIN
  SELECT decrypted_secret INTO secret
  FROM vault.decrypted_secrets WHERE name = 'market_cron_secret';
  RETURN net.http_post(
    url := 'https://ybtaxgstmxnlwurkritg.supabase.co/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
END $$;
REVOKE ALL ON FUNCTION public.market_cron_call(text) FROM public, anon, authenticated;

-- Schedules (UTC; IST = UTC+5:30). Weekdays only for market jobs.
SELECT cron.schedule('market-kotak-refresh',       '35 3 * * 1-5',   $$SELECT public.market_cron_call('market-kotak-refresh')$$);
SELECT cron.schedule('market-pipeline-eod',        '*/5 13-14 * * 1-5', $$SELECT public.market_cron_call('market-pipeline-eod')$$);
SELECT cron.schedule('market-pipeline-aggregates', '30 14 * * 1-5',  $$SELECT public.market_cron_call('market-pipeline-aggregates')$$);
SELECT cron.schedule('market-scrips-sync',         '0 2 * * 6',      $$SELECT public.market_cron_call('market-scrips-sync')$$);
