-- Global fundamentals snapshot for the screener (one row per symbol, no user_id).
CREATE TABLE IF NOT EXISTS public.market_fundamentals_global (
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  company_name text,
  sector text,
  industry text,
  market_cap_cr numeric,
  price numeric,
  pe_ttm numeric,
  pb numeric,
  peg numeric,
  eps_ttm numeric,
  dividend_yield numeric,
  book_value numeric,
  roe numeric,
  roce numeric,
  debt_to_equity numeric,
  current_ratio numeric,
  quick_ratio numeric,
  revenue_ttm_cr numeric,
  profit_ttm_cr numeric,
  revenue_growth_yoy numeric,
  profit_growth_yoy numeric,
  eps_growth_yoy numeric,
  promoter_holding numeric,
  promoter_pledge numeric,
  fii_holding numeric,
  dii_holding numeric,
  face_value numeric,
  high_52w numeric,
  low_52w numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, exchange)
);

CREATE INDEX IF NOT EXISTS mfg_sector_idx ON public.market_fundamentals_global (sector);
CREATE INDEX IF NOT EXISTS mfg_industry_idx ON public.market_fundamentals_global (industry);
CREATE INDEX IF NOT EXISTS mfg_mcap_idx ON public.market_fundamentals_global (market_cap_cr);

GRANT SELECT ON public.market_fundamentals_global TO authenticated, anon;
GRANT ALL ON public.market_fundamentals_global TO service_role;

ALTER TABLE public.market_fundamentals_global ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read global fundamentals"
  ON public.market_fundamentals_global
  FOR SELECT
  TO authenticated, anon
  USING (true);

CREATE TRIGGER mfg_touch_updated_at
  BEFORE UPDATE ON public.market_fundamentals_global
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();