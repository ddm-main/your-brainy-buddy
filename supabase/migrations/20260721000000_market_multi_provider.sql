-- Multi-provider market data architecture
-- Unified schema that all providers (Kotak, FMP, Yahoo, Alpha Vantage, NSE, BSE, Stooq) map into.
-- Replaces the fragmented market_stocks + market_fundamentals_global + market_stock_scores split.

CREATE TABLE IF NOT EXISTS public.market_data (
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',

  -- Structural (applies to all)
  company_name text,
  sector text,
  industry text,
  instrument_type text DEFAULT 'EQ',
  is_nifty500 boolean DEFAULT false,
  in_universe boolean DEFAULT false,
  is_active boolean DEFAULT true,

  -- Price & Market Cap
  ltp numeric,
  previous_close numeric,
  market_cap numeric, -- ₹ Cr
  enterprise_value numeric, -- ₹ Cr
  shares_outstanding numeric, -- in Cr
  face_value numeric,

  -- Valuation
  pe numeric,
  forward_pe numeric,
  pb numeric,
  peg numeric,
  eps numeric,
  book_value numeric,
  dividend_yield numeric,
  ev_ebitda numeric,

  -- Profitability
  roe numeric,
  roce numeric,
  roa numeric,
  operating_margin numeric,
  net_margin numeric,

  -- Growth (YoY %)
  sales numeric, -- TTM revenue ₹ Cr
  net_profit numeric, -- TTM profit ₹ Cr
  sales_growth numeric,
  profit_growth numeric,
  eps_growth numeric,

  -- Financial Health
  debt numeric, -- ₹ Cr
  debt_equity numeric,
  current_ratio numeric,
  quick_ratio numeric,
  interest_coverage numeric,
  cash_flow numeric, -- operating cash flow ₹ Cr
  free_cash_flow numeric, -- ₹ Cr

  -- Ownership (%)
  promoter_holding numeric,
  promoter_pledge numeric,
  fii_holding numeric,
  dii_holding numeric,
  public_holding numeric,

  -- 52-Week Range
  high_52w numeric,
  low_52w numeric,

  -- Technical Indicators
  sma_200 numeric,
  sma_50 numeric,
  sma_20 numeric,
  ema_200 numeric,
  ema_100 numeric,
  ema_50 numeric,
  ema_20 numeric,
  rsi numeric,
  macd numeric,
  macd_signal numeric,
  macd_hist numeric,
  adx numeric,
  atr numeric,
  atr_pct numeric,
  bb_upper numeric,
  bb_lower numeric,
  bb_width numeric,
  bb_squeeze boolean,

  -- Intraday
  volume bigint,
  delivery_percent numeric,
  change_abs numeric,
  change_pct numeric,
  rel_volume numeric,
  vol_avg_20 numeric,

  -- Scoring & Signals (computed)
  breakout_score integer,
  prebreakout_score integer,
  above_ema_200 boolean,
  higher_lows boolean,
  near_resistance boolean,
  resistance_level numeric,
  support_level numeric,
  sector_strength numeric,
  rel_strength_nifty numeric,
  pct_from_52w_high numeric,
  score_components jsonb,

  -- Meta
  beta numeric,
  trade_date date,
  as_of timestamptz,
  previous_close_as_of timestamptz,
  data_source jsonb, -- {"ltp": "kotak", "pe": "fmp", "roe": "yahoo", "rsi": "alphavantage"}
  last_updated timestamptz NOT NULL DEFAULT now(),

  -- Provider-specific tokens (for live data sources)
  kotak_token text,
  yahoo_symbol text,

  -- Sync cursors (per-provider, so each sync job can page independently)
  fmp_synced_at timestamptz,
  alpha_synced_at timestamptz,

  PRIMARY KEY (symbol, exchange)
);

-- Indexes for fast screening queries
CREATE INDEX idx_market_data_sector ON public.market_data (sector) WHERE is_active;
CREATE INDEX idx_market_data_market_cap ON public.market_data (market_cap DESC NULLS LAST) WHERE is_active;
CREATE INDEX idx_market_data_pe ON public.market_data (pe) WHERE is_active AND pe IS NOT NULL;
CREATE INDEX idx_market_data_roe ON public.market_data (roe DESC NULLS LAST) WHERE is_active AND roe IS NOT NULL;
CREATE INDEX idx_market_data_rsi ON public.market_data (rsi) WHERE is_active AND rsi IS NOT NULL;
CREATE INDEX idx_market_data_breakout ON public.market_data (breakout_score DESC NULLS LAST) WHERE is_active;
CREATE INDEX idx_market_data_universe_cursor ON public.market_data (in_universe, last_updated NULLS FIRST) WHERE is_active;
CREATE INDEX idx_market_data_fmp_cursor ON public.market_data (fmp_synced_at NULLS FIRST) WHERE is_active AND instrument_type = 'EQ';
CREATE INDEX idx_market_data_trade_date ON public.market_data (trade_date DESC NULLS LAST) WHERE is_active;

GRANT SELECT ON public.market_data TO authenticated, anon;
GRANT ALL ON public.market_data TO service_role;

ALTER TABLE public.market_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read market_data" ON public.market_data
  FOR SELECT TO authenticated, anon USING (true);

-- Migrate existing data from the three old tables
INSERT INTO public.market_data (
  symbol, exchange, company_name, sector, industry, instrument_type,
  is_nifty500, in_universe, is_active,
  ltp, previous_close, market_cap, face_value,
  pe, pb, peg, eps, book_value, dividend_yield,
  roe, roce,
  sales, net_profit, sales_growth, profit_growth, eps_growth,
  debt_equity, current_ratio, quick_ratio,
  promoter_holding, promoter_pledge, fii_holding, dii_holding,
  high_52w, low_52w,
  ema_200, ema_100, ema_50, ema_20,
  rsi, macd, macd_signal, macd_hist, adx, atr, atr_pct,
  bb_upper, bb_lower, bb_width, bb_squeeze,
  volume, delivery_percent, change_abs, change_pct, rel_volume, vol_avg_20,
  breakout_score, prebreakout_score, above_ema_200, higher_lows,
  near_resistance, resistance_level, support_level,
  sector_strength, rel_strength_nifty, pct_from_52w_high,
  score_components, trade_date,
  kotak_token, yahoo_symbol,
  last_updated
)
SELECT
  s.symbol,
  s.exchange,
  COALESCE(f.company_name, s.company_name) AS company_name,
  COALESCE(f.sector, s.sector, sc.sector) AS sector,
  COALESCE(f.industry, s.industry) AS industry,
  COALESCE(s.instrument_type, 'EQ') AS instrument_type,
  s.is_nifty500,
  s.in_universe,
  s.is_active,

  -- Price & Market Cap
  COALESCE(sc.close, f.price) AS ltp,
  NULL AS previous_close,
  COALESCE(f.market_cap_cr, s.market_cap) AS market_cap,
  f.face_value,

  -- Valuation
  f.pe_ttm AS pe,
  NULL AS forward_pe,
  f.pb,
  f.peg,
  f.eps_ttm AS eps,
  f.book_value,
  f.dividend_yield,

  -- Profitability
  f.roe,
  f.roce,

  -- Growth
  f.revenue_ttm_cr AS sales,
  f.profit_ttm_cr AS net_profit,
  f.revenue_growth_yoy AS sales_growth,
  f.profit_growth_yoy AS profit_growth,
  f.eps_growth_yoy AS eps_growth,

  -- Financial Health
  f.debt_to_equity AS debt_equity,
  f.current_ratio,
  f.quick_ratio,

  -- Ownership
  f.promoter_holding,
  f.promoter_pledge,
  f.fii_holding,
  f.dii_holding,

  -- 52-Week Range
  COALESCE(sc.high_52w, f.high_52w) AS high_52w,
  COALESCE(sc.low_52w, f.low_52w) AS low_52w,

  -- Technical Indicators
  sc.ema200 AS ema_200,
  sc.ema100 AS ema_100,
  sc.ema50 AS ema_50,
  sc.ema20 AS ema_20,
  sc.rsi14 AS rsi,
  sc.macd,
  sc.macd_signal,
  sc.macd_hist,
  sc.adx14 AS adx,
  sc.atr14 AS atr,
  sc.atr_pct,
  sc.bb_upper,
  sc.bb_lower,
  sc.bb_width,
  sc.bb_squeeze,

  -- Intraday
  sc.volume,
  sc.delivery_pct AS delivery_percent,
  NULL AS change_abs,
  sc.change_pct,
  sc.rel_volume,
  sc.vol_avg20 AS vol_avg_20,

  -- Scoring
  sc.breakout_score,
  sc.prebreakout_score,
  sc.above_ema200 AS above_ema_200,
  sc.higher_lows,
  sc.near_resistance,
  sc.resistance_level,
  sc.support_level,
  sc.sector_strength,
  sc.rel_strength_nifty,
  sc.pct_from_52w_high,
  sc.score_components,
  sc.trade_date,

  -- Provider tokens
  s.token AS kotak_token,
  s.yahoo_symbol,

  -- Timestamps
  GREATEST(
    s.updated_at,
    COALESCE(f.updated_at, '1970-01-01'::timestamptz),
    COALESCE(sc.computed_at, '1970-01-01'::timestamptz)
  ) AS last_updated

FROM public.market_stocks s
LEFT JOIN public.market_fundamentals_global f USING (symbol, exchange)
LEFT JOIN public.market_stock_scores sc USING (symbol, exchange)
WHERE s.is_active = true;

-- Populate data_source from existing sync_source field
UPDATE public.market_data md
SET data_source = jsonb_build_object(
  'ltp', CASE
    WHEN md.kotak_token IS NOT NULL THEN 'kotak'
    WHEN md.yahoo_symbol IS NOT NULL THEN 'yahoo'
    ELSE NULL
  END,
  'pe', CASE
    WHEN EXISTS (
      SELECT 1 FROM market_fundamentals_global f
      WHERE f.symbol = md.symbol AND f.exchange = md.exchange
        AND f.sync_source LIKE '%yahoo%'
    ) THEN 'yahoo'
    WHEN EXISTS (
      SELECT 1 FROM market_fundamentals_global f
      WHERE f.symbol = md.symbol AND f.exchange = md.exchange
        AND f.sync_source LIKE '%nse%'
    ) THEN 'nse'
    ELSE NULL
  END,
  'sector', CASE
    WHEN EXISTS (
      SELECT 1 FROM market_fundamentals_global f
      WHERE f.symbol = md.symbol AND f.exchange = md.exchange
        AND f.sector IS NOT NULL
    ) THEN 'yahoo+nse'
    ELSE NULL
  END
)
WHERE md.ltp IS NOT NULL OR md.pe IS NOT NULL OR md.sector IS NOT NULL;

-- Comment on table
COMMENT ON TABLE public.market_data IS 'Unified market data from multiple providers (Kotak, FMP, Yahoo, Alpha Vantage, NSE, BSE, Stooq). All provider-specific fields normalized into this schema. data_source JSONB tracks which provider supplied each field.';

-- Update trigger for last_updated
CREATE TRIGGER market_data_touch_updated_at
  BEFORE UPDATE ON public.market_data
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Helper function for validation engine — check for duplicate symbols
CREATE OR REPLACE FUNCTION public.check_duplicate_symbols()
RETURNS TABLE(symbol text, exchange text, count bigint) AS $$
  SELECT symbol, exchange, count(*) as count
  FROM public.market_data
  WHERE is_active = true
  GROUP BY symbol, exchange
  HAVING count(*) > 1;
$$ LANGUAGE SQL SECURITY DEFINER;

-- -------------------------------------------------------------------------
-- Cron: FMP nightly trickle (well after NSE close, budget ~35 symbols/run
-- against the 250 req/day free-tier cap) and validation engine (after FMP
-- and the EOD/aggregates passes have both landed).
-- -------------------------------------------------------------------------
SELECT cron.unschedule('market-fmp-sync') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-fmp-sync');
SELECT cron.schedule('market-fmp-sync', '30 16 * * 1-5',
  $$SELECT public.market_cron_call('market-fmp-sync')$$);

SELECT cron.unschedule('market-data-validation') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'market-data-validation');
SELECT cron.schedule('market-data-validation', '0 17 * * 1-5',
  $$SELECT public.market_cron_call('market-data-validation')$$);
