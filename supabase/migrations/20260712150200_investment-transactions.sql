-- SIP/lumpsum/buy/sell/dividend ledger. Where a transaction history exists
-- for a holding, it is the source of truth for units/invested_amount/avg_cost
-- and XIRR — computed on read by src/lib/investmentCalc.ts, never synced onto
-- investment_holdings on write (avoids the two-write drift risk that the
-- earlier goal_contributions design deliberately avoided via a DB trigger;
-- here the derived numbers are just never stored at all). Holdings with no
-- transaction history fall back to their own manually-entered units/
-- invested_amount/avg_cost columns.

CREATE TABLE IF NOT EXISTS public.investment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holding_id uuid NOT NULL REFERENCES public.investment_holdings(id) ON DELETE CASCADE,
  txn_type text NOT NULL CHECK (txn_type IN ('buy','sell','sip','dividend','bonus','split')),
  txn_date date NOT NULL,
  units numeric(18,4),
  price numeric(14,4),
  amount numeric(14,2) NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','groww_pdf','groww_csv')),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE public.investment_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner rw" ON public.investment_transactions FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.investment_transactions FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.investment_transactions TO authenticated;
GRANT ALL ON public.investment_transactions TO service_role;

CREATE INDEX IF NOT EXISTS investment_transactions_holding_idx
  ON public.investment_transactions(holding_id, txn_date DESC);
