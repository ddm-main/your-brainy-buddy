-- One discriminator-column table for every asset type (mutual fund, stock,
-- and the 9 optional types hidden by default behind user_finance_settings'
-- toggle) rather than 11 near-identical tables. The columns that don't apply
-- to a given asset_type are just left null — e.g. expense_ratio/aum only
-- matter for mutual_fund, pe_ratio/sector only for stock.

CREATE TABLE IF NOT EXISTS public.investment_holdings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_account_id uuid REFERENCES public.investment_accounts(id) ON DELETE SET NULL,
  asset_type text NOT NULL CHECK (asset_type IN (
    'mutual_fund','stock','etf','gold','ppf','epf','nps','fd','bonds','real_estate','crypto'
  )),
  name text NOT NULL,
  symbol_or_scheme_code text,
  folio_or_demat_number text,
  units numeric(18,4),
  avg_cost numeric(14,4),
  invested_amount numeric(14,2),
  current_value numeric(14,2),
  current_price numeric(14,4),
  current_price_updated_at timestamptz,
  current_price_source text CHECK (current_price_source IN ('amfi','manual')),
  category text,
  risk_level text,
  expense_ratio numeric(5,2),
  aum numeric(16,2),
  rating smallint,
  sector text,
  pe_ratio numeric(8,2),
  dividend_yield numeric(5,2),
  week52_high numeric(14,4),
  week52_low numeric(14,4),
  is_watchlist boolean NOT NULL DEFAULT false,
  goal_id uuid REFERENCES public.financial_goals(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE public.investment_holdings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner rw" ON public.investment_holdings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.investment_holdings FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.investment_holdings TO authenticated;
GRANT ALL ON public.investment_holdings TO service_role;

CREATE INDEX IF NOT EXISTS investment_holdings_user_type_idx
  ON public.investment_holdings(user_id, asset_type);
CREATE INDEX IF NOT EXISTS investment_holdings_scheme_idx
  ON public.investment_holdings(symbol_or_scheme_code) WHERE symbol_or_scheme_code IS NOT NULL;
