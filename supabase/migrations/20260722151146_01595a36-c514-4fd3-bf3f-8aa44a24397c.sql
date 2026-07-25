
DROP VIEW IF EXISTS public.market_screener_rows;

ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS sub_sector text,
  ADD COLUMN IF NOT EXISTS sub_sector_source text;

CREATE TABLE IF NOT EXISTS public.market_sector_map (
  nse_sector text NOT NULL,
  industry   text NOT NULL DEFAULT '',
  sub_sector text NOT NULL,
  source     text NOT NULL DEFAULT 'seed',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (nse_sector, industry)
);
GRANT SELECT ON public.market_sector_map TO anon, authenticated;
GRANT ALL ON public.market_sector_map TO service_role;
ALTER TABLE public.market_sector_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sector_map_read_all" ON public.market_sector_map;
CREATE POLICY "sector_map_read_all" ON public.market_sector_map FOR SELECT USING (true);

INSERT INTO public.market_sector_map (nse_sector, industry, sub_sector) VALUES
  ('Healthcare',              '', 'Pharmaceuticals'),
  ('Pharmaceuticals',         '', 'Pharmaceuticals'),
  ('Industrials',             '', 'Diversified Industrials'),
  ('Chemicals',               '', 'Diversified Chemicals'),
  ('Technology',              '', 'IT Services'),
  ('Information Technology',  '', 'IT Services'),
  ('Communication Services',  '', 'Telecom Services'),
  ('Telecom',                 '', 'Telecom Services'),
  ('Financial Services',      '', 'Financial Services'),
  ('Consumer Cyclical',       '', 'Auto Parts'),
  ('Auto & Auto Components',  '', 'Auto Parts'),
  ('Energy',                  '', 'Energy'),
  ('Utilities',               '', 'Power'),
  ('Consumer Staples',        '', 'FMCG'),
  ('Materials',               '', 'Metals & Mining'),
  ('Real Estate',             '', 'Real Estate'),
  ('Consumer Durables',       '', 'Consumer Durables'),
  ('Metals & Mining',         '', 'Metals & Mining'),
  ('Media & Entertainment',   '', 'Media')
ON CONFLICT DO NOTHING;

ALTER TABLE public.market_fundamentals_global
  ADD COLUMN IF NOT EXISTS pe_source text,
  ADD COLUMN IF NOT EXISTS pe_as_of timestamptz,
  ADD COLUMN IF NOT EXISTS roe_source text,
  ADD COLUMN IF NOT EXISTS roe_as_of timestamptz,
  ADD COLUMN IF NOT EXISTS de_source text,
  ADD COLUMN IF NOT EXISTS de_as_of timestamptz,
  ADD COLUMN IF NOT EXISTS eps_source text,
  ADD COLUMN IF NOT EXISTS eps_as_of timestamptz,
  ADD COLUMN IF NOT EXISTS book_value_source text,
  ADD COLUMN IF NOT EXISTS book_value_as_of timestamptz,
  ADD COLUMN IF NOT EXISTS market_cap_cr_source text,
  ADD COLUMN IF NOT EXISTS market_cap_cr_as_of timestamptz;

ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS close_adjusted numeric,
  ADD COLUMN IF NOT EXISTS prev_close_adjusted numeric,
  ADD COLUMN IF NOT EXISTS change_pct_adjusted numeric;

CREATE VIEW public.market_screener_rows AS
WITH latest_shares AS (
  SELECT DISTINCT ON (symbol) symbol, total_shares, as_of, source AS shares_source
    FROM public.market_shares_outstanding
   ORDER BY symbol, as_of DESC
)
SELECT
  s.symbol,
  s.exchange,
  s.company_name,
  COALESCE(f.sector, s.sector, sc.sector) AS sector,
  COALESCE(s.sub_sector, sm_i.sub_sector, sm_b.sub_sector, f.industry, s.industry) AS sub_sector,
  COALESCE(f.industry, s.industry) AS industry,
  COALESCE(f.market_cap_cr, s.market_cap) AS market_cap_reported,
  CASE
    WHEN ls.total_shares IS NOT NULL AND en.close IS NOT NULL AND en.close > 0 THEN round(ls.total_shares * en.close / 10000000, 2)
    WHEN ls.total_shares IS NOT NULL AND sc.close IS NOT NULL AND sc.close > 0 THEN round(ls.total_shares * sc.close / 10000000, 2)
    WHEN f.market_cap_cr IS NOT NULL AND f.price IS NOT NULL AND f.price > 0 AND sc.close IS NOT NULL AND sc.close > 0 THEN round(f.market_cap_cr * (sc.close / f.price), 2)
    ELSE COALESCE(f.market_cap_cr, s.market_cap)
  END AS market_cap,
  s.is_nifty500,
  s.in_universe,
  s.is_active,
  COALESCE(s.instrument_type, 'EQ') AS instrument_type,
  s.yahoo_symbol,
  s.last_price_sync_at,
  s.last_fundamentals_sync_at,
  (EXISTS (
    SELECT 1 FROM public.market_stocks x
    WHERE x.symbol = s.symbol AND x.is_active = true
      AND x.instrument_type = ANY (ARRAY['FUT','OPT','FUTIDX','OPTIDX','FUTSTK','OPTSTK'])
  )) AS fno_enabled,
  COALESCE(s.series = ANY (ARRAY['BE','BZ','SM','ST','SME']), false) AS sme,
  sc.id AS score_id,
  COALESCE(en.trade_date, sc.trade_date) AS trade_date,
  COALESCE(en.close, sc.close) AS close,
  CASE
    WHEN sc.change_pct_adjusted IS NOT NULL THEN sc.change_pct_adjusted
    WHEN en.close IS NOT NULL AND en.prev_close IS NOT NULL AND en.prev_close > 0
      THEN round((en.close - en.prev_close) / en.prev_close * 100, 2)
    ELSE sc.change_pct
  END AS change_pct,
  COALESCE(en.volume, sc.volume) AS volume,
  en.prev_close AS previous_close,
  sc.close_adjusted,
  sc.vol_avg20, sc.rel_volume,
  sc.ema20, sc.ema50, sc.ema100, sc.ema200,
  sc.rsi14, sc.macd, sc.macd_signal, sc.macd_hist,
  sc.adx14, sc.atr14, sc.atr_pct,
  sc.bb_upper, sc.bb_lower, sc.bb_width, sc.bb_squeeze,
  sc.high_52w, sc.low_52w, sc.pct_from_52w_high,
  sc.above_ema200, sc.higher_lows, sc.near_resistance,
  sc.resistance_level, sc.support_level,
  sc.sector_strength, sc.rel_strength_nifty,
  sc.breakout_score, sc.prebreakout_score, sc.score_components,
  sc.computed_at, sc.ret_5d, sc.ret_21d, sc.ret_ytd,
  f.price AS fundamental_price,
  f.pe_ttm, f.pb, f.peg, f.eps_ttm, f.book_value,
  f.dividend_yield, f.roe, f.roce, f.debt_to_equity,
  f.current_ratio, f.quick_ratio,
  f.revenue_ttm_cr, f.profit_ttm_cr,
  f.revenue_growth_yoy, f.profit_growth_yoy, f.eps_growth_yoy,
  f.promoter_holding, f.promoter_pledge, f.fii_holding, f.dii_holding,
  f.face_value,
  f.high_52w AS fundamental_high_52w,
  f.low_52w  AS fundamental_low_52w,
  f.sync_source, f.sync_status, f.last_error, f.data_as_of,
  f.last_attempted_at, f.updated_at AS fundamentals_updated_at,
  jsonb_build_object(
    'close',       CASE WHEN en.close  IS NOT NULL THEN 'nse_bhavcopy' ELSE 'stock_scores' END,
    'close_as_of', COALESCE(en.trade_date, sc.trade_date),
    'volume',      CASE WHEN en.volume IS NOT NULL THEN 'nse_bhavcopy' ELSE 'stock_scores' END,
    'mcap',        CASE
                     WHEN ls.total_shares IS NOT NULL AND en.close IS NOT NULL THEN 'shares_x_nse_close'
                     WHEN ls.total_shares IS NOT NULL THEN 'shares_x_scores_close'
                     WHEN f.market_cap_cr IS NOT NULL AND sc.close IS NOT NULL THEN 'fmp_repriced'
                     ELSE 'fmp_raw'
                   END,
    'shares_source', ls.shares_source,
    'shares_as_of',  ls.as_of,
    'nse_trade_date', en.trade_date,
    'change_pct_source', CASE
                          WHEN sc.change_pct_adjusted IS NOT NULL THEN 'adjusted_close'
                          WHEN en.prev_close IS NOT NULL THEN 'nse_prev_close'
                          ELSE 'stock_scores'
                        END,
    'pe_source',  COALESCE(f.pe_source,  f.sync_source),
    'pe_as_of',   COALESCE(f.pe_as_of,   f.updated_at),
    'roe_source', COALESCE(f.roe_source, f.sync_source),
    'roe_as_of',  COALESCE(f.roe_as_of,  f.updated_at),
    'de_source',  COALESCE(f.de_source,  f.sync_source),
    'de_as_of',   COALESCE(f.de_as_of,   f.updated_at),
    'sub_sector_source', COALESCE(s.sub_sector_source, sm_i.source, sm_b.source, 'derived')
  ) AS data_provenance,
  en.close IS NOT NULL AND en.volume IS NOT NULL AND ls.total_shares IS NOT NULL
    AND ls.as_of >= (CURRENT_DATE - INTERVAL '3 days') AS strict_ok
FROM public.market_stocks s
LEFT JOIN public.market_stock_scores sc ON sc.symbol = s.symbol AND sc.exchange = s.exchange
LEFT JOIN public.market_fundamentals_global f ON f.symbol = s.symbol AND f.exchange = s.exchange
LEFT JOIN LATERAL (
  SELECT e.close, e.volume, e.prev_close, e.trade_date
    FROM public.market_eod_nse e
   WHERE e.symbol = s.symbol
   ORDER BY e.trade_date DESC
   LIMIT 1
) en ON true
LEFT JOIN latest_shares ls ON ls.symbol = s.symbol
LEFT JOIN public.market_sector_map sm_i
  ON sm_i.nse_sector = COALESCE(f.sector, s.sector)
 AND sm_i.industry   = COALESCE(f.industry, s.industry, '')
LEFT JOIN public.market_sector_map sm_b
  ON sm_b.nse_sector = COALESCE(f.sector, s.sector)
 AND sm_b.industry   = ''
WHERE s.is_active = true;

GRANT SELECT ON public.market_screener_rows TO anon, authenticated;
