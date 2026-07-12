-- Round 6: Investments merged into Finance (not a separate module). This is
-- the broker/AMC wrapper used to group holdings and attribute imports (e.g.
-- "which Groww account did this holding come from"). Optional on every
-- holding — manual entries with no linked account are fine.

CREATE TABLE IF NOT EXISTS public.investment_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text CHECK (provider IN ('groww','zerodha','direct_amc','manual','other')),
  account_name text NOT NULL,
  account_number_masked text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE public.investment_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner rw" ON public.investment_accounts FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.investment_accounts FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.investment_accounts TO authenticated;
GRANT ALL ON public.investment_accounts TO service_role;
