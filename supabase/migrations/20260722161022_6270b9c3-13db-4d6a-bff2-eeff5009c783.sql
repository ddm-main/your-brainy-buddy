
ALTER TABLE public.market_daily_prices
  ADD COLUMN IF NOT EXISTS open_adjusted  numeric,
  ADD COLUMN IF NOT EXISTS high_adjusted  numeric,
  ADD COLUMN IF NOT EXISTS low_adjusted   numeric,
  ADD COLUMN IF NOT EXISTS close_adjusted numeric,
  ADD COLUMN IF NOT EXISTS adj_factor     numeric DEFAULT 1,
  ADD COLUMN IF NOT EXISTS adj_applied_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_mdp_symbol_date_adj
  ON public.market_daily_prices (symbol, trade_date DESC)
  WHERE close_adjusted IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.corporate_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol        text NOT NULL,
  exchange      text NOT NULL DEFAULT 'NSE',
  action_type   text NOT NULL CHECK (action_type IN ('split','bonus','dividend','rights','merger','spinoff')),
  ex_date       date NOT NULL,
  ratio_from    numeric,
  ratio_to      numeric,
  amount        numeric,
  purpose       text,
  source        text,
  source_hash   text,
  applied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_corp_actions_natural
  ON public.corporate_actions (
    symbol, exchange, action_type, ex_date,
    COALESCE(ratio_from, 0), COALESCE(ratio_to, 0), COALESCE(amount, 0)
  );

GRANT SELECT ON public.corporate_actions TO authenticated;
GRANT ALL    ON public.corporate_actions TO service_role;
ALTER TABLE public.corporate_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "corp actions readable by authenticated"
  ON public.corporate_actions FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_corp_actions_symbol_date
  ON public.corporate_actions (symbol, ex_date DESC);
CREATE INDEX IF NOT EXISTS idx_corp_actions_unapplied
  ON public.corporate_actions (applied_at) WHERE applied_at IS NULL;

DROP TRIGGER IF EXISTS trg_corp_actions_updated_at ON public.corporate_actions;
CREATE TRIGGER trg_corp_actions_updated_at
  BEFORE UPDATE ON public.corporate_actions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.market_fundamentals_provenance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol       text NOT NULL,
  exchange     text NOT NULL DEFAULT 'NSE',
  field_name   text NOT NULL,
  value        numeric,
  source       text NOT NULL,
  source_url   text,
  data_as_of   timestamptz,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, exchange, field_name)
);

GRANT SELECT ON public.market_fundamentals_provenance TO authenticated;
GRANT ALL    ON public.market_fundamentals_provenance TO service_role;
ALTER TABLE public.market_fundamentals_provenance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fundamentals provenance readable by authenticated"
  ON public.market_fundamentals_provenance FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_fund_prov_symbol
  ON public.market_fundamentals_provenance (symbol, exchange);

DROP TRIGGER IF EXISTS trg_fund_prov_updated_at ON public.market_fundamentals_provenance;
CREATE TRIGGER trg_fund_prov_updated_at
  BEFORE UPDATE ON public.market_fundamentals_provenance
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS total_shares_cr    numeric,
  ADD COLUMN IF NOT EXISTS free_float_cr      numeric,
  ADD COLUMN IF NOT EXISTS shares_source      text,
  ADD COLUMN IF NOT EXISTS shares_as_of       timestamptz,
  ADD COLUMN IF NOT EXISTS market_cap_calc_at timestamptz;
