DROP VIEW IF EXISTS public.market_screener_rows;

CREATE TABLE IF NOT EXISTS public.market_provider_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  metric text NOT NULL,
  provider text NOT NULL,
  value numeric,
  unit text,
  provider_as_of timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  confidence numeric NOT NULL DEFAULT 0.5,
  status text NOT NULL DEFAULT 'ok',
  source_method text,
  raw_payload_hash text,
  raw_payload jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_provider_observations_confidence_chk CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT market_provider_observations_status_chk CHECK (status IN ('ok','partial','stale','missing','error','rejected')),
  CONSTRAINT market_provider_observations_metric_chk CHECK (metric <> ''),
  CONSTRAINT market_provider_observations_provider_chk CHECK (provider <> '')
);
GRANT ALL ON public.market_provider_observations TO service_role;
ALTER TABLE public.market_provider_observations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service manages provider observations" ON public.market_provider_observations;
CREATE POLICY "service manages provider observations" ON public.market_provider_observations FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_market_provider_observations_symbol_metric ON public.market_provider_observations (symbol, exchange, metric, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_provider_observations_provider ON public.market_provider_observations (provider, metric, fetched_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_market_provider_observation_dedupe ON public.market_provider_observations (symbol, exchange, metric, provider, fetched_at, COALESCE(raw_payload_hash, ''));

CREATE TABLE IF NOT EXISTS public.market_metric_consensus (
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  metric text NOT NULL,
  value numeric,
  unit text,
  source_provider text NOT NULL,
  source_method text NOT NULL,
  confidence numeric NOT NULL DEFAULT 0.5,
  ref_value numeric,
  delta_pct numeric,
  status text NOT NULL DEFAULT 'ok',
  provider_as_of timestamptz,
  computed_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, exchange, metric),
  CONSTRAINT market_metric_consensus_confidence_chk CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT market_metric_consensus_status_chk CHECK (status IN ('ok','estimated','stale','missing','mismatch','error')),
  CONSTRAINT market_metric_consensus_metric_chk CHECK (metric <> '')
);
GRANT SELECT ON public.market_metric_consensus TO anon, authenticated;
GRANT ALL ON public.market_metric_consensus TO service_role;
ALTER TABLE public.market_metric_consensus ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read market metric consensus" ON public.market_metric_consensus;
CREATE POLICY "read market metric consensus" ON public.market_metric_consensus FOR SELECT USING (true);
DROP POLICY IF EXISTS "service manages market metric consensus" ON public.market_metric_consensus;
CREATE POLICY "service manages market metric consensus" ON public.market_metric_consensus FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_market_metric_consensus_metric ON public.market_metric_consensus (metric, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_metric_consensus_status ON public.market_metric_consensus (status, metric);

CREATE TABLE IF NOT EXISTS public.market_reference_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'tickertape',
  mode text NOT NULL DEFAULT 'sample',
  status text NOT NULL DEFAULT 'running',
  symbols_requested integer NOT NULL DEFAULT 0,
  symbols_checked integer NOT NULL DEFAULT 0,
  mismatches integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_reference_audit_runs_status_chk CHECK (status IN ('running','ok','partial','failed'))
);
GRANT SELECT ON public.market_reference_audit_runs TO authenticated;
GRANT ALL ON public.market_reference_audit_runs TO service_role;
ALTER TABLE public.market_reference_audit_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit runs read for authed" ON public.market_reference_audit_runs;
CREATE POLICY "audit runs read for authed" ON public.market_reference_audit_runs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "service manages audit runs" ON public.market_reference_audit_runs;
CREATE POLICY "service manages audit runs" ON public.market_reference_audit_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_market_reference_audit_runs_started ON public.market_reference_audit_runs (started_at DESC);

ALTER TABLE public.market_value_audit
  ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES public.market_reference_audit_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_provider text,
  ADD COLUMN IF NOT EXISTS source_method text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS threshold_pct numeric,
  ADD COLUMN IF NOT EXISTS remediation text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_market_value_audit_run ON public.market_value_audit (run_id);
CREATE INDEX IF NOT EXISTS idx_market_value_audit_symbol_checked ON public.market_value_audit (symbol, checked_at DESC);

CREATE OR REPLACE TRIGGER update_market_provider_observations_updated_at
BEFORE UPDATE ON public.market_provider_observations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE TRIGGER update_market_metric_consensus_updated_at
BEFORE UPDATE ON public.market_metric_consensus
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE TRIGGER update_market_reference_audit_runs_updated_at
BEFORE UPDATE ON public.market_reference_audit_runs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE VIEW public.market_screener_rows
WITH (security_invoker=on) AS
WITH latest_shares AS (
  SELECT DISTINCT ON (symbol) symbol, total_shares, as_of, source AS shares_source
    FROM public.market_shares_outstanding
   ORDER BY symbol, as_of DESC
), consensus AS (
  SELECT symbol, exchange,
         max(value) FILTER (WHERE metric = 'market_cap') AS consensus_market_cap,
         max(source_provider) FILTER (WHERE metric = 'market_cap') AS consensus_market_cap_provider,
         max(source_method) FILTER (WHERE metric = 'market_cap') AS consensus_market_cap_method,
         max(confidence) FILTER (WHERE metric = 'market_cap') AS consensus_market_cap_confidence,
         max(status) FILTER (WHERE metric = 'market_cap') AS consensus_market_cap_status,
         max(delta_pct) FILTER (WHERE metric = 'market_cap') AS consensus_market_cap_delta_pct,
         max(computed_at) FILTER (WHERE metric = 'market_cap') AS consensus_market_cap_as_of
    FROM public.market_metric_consensus
   WHERE metric IN ('market_cap')
   GROUP BY symbol, exchange
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
    WHEN c.consensus_market_cap IS NOT NULL THEN round(c.consensus_market_cap, 2)
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
                     WHEN c.consensus_market_cap IS NOT NULL THEN 'consensus'
                     WHEN ls.total_shares IS NOT NULL AND en.close IS NOT NULL THEN 'shares_x_nse_close'
                     WHEN ls.total_shares IS NOT NULL THEN 'shares_x_scores_close'
                     WHEN f.market_cap_cr IS NOT NULL AND sc.close IS NOT NULL THEN 'fmp_repriced'
                     ELSE 'fmp_raw'
                   END,
    'mcap_provider', c.consensus_market_cap_provider,
    'mcap_method', c.consensus_market_cap_method,
    'mcap_confidence', c.consensus_market_cap_confidence,
    'mcap_status', c.consensus_market_cap_status,
    'mcap_delta_pct', c.consensus_market_cap_delta_pct,
    'mcap_as_of', c.consensus_market_cap_as_of,
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
  en.close IS NOT NULL AND en.volume IS NOT NULL AND (
    (c.consensus_market_cap IS NOT NULL AND c.consensus_market_cap_status IN ('ok','estimated')) OR
    (ls.total_shares IS NOT NULL AND ls.as_of >= (CURRENT_DATE - INTERVAL '3 days'))
  ) AS strict_ok
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
LEFT JOIN consensus c ON c.symbol = s.symbol AND c.exchange = s.exchange
LEFT JOIN public.market_sector_map sm_i
  ON sm_i.nse_sector = COALESCE(f.sector, s.sector)
 AND sm_i.industry   = COALESCE(f.industry, s.industry, '')
LEFT JOIN public.market_sector_map sm_b
  ON sm_b.nse_sector = COALESCE(f.sector, s.sector)
 AND sm_b.industry   = ''
WHERE s.is_active = true;

GRANT SELECT ON public.market_screener_rows TO anon, authenticated;
GRANT ALL ON public.market_screener_rows TO service_role;