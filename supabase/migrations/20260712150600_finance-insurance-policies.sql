-- Insurance policy tracking (health/life/term/vehicle/home/other). Renewal
-- alerts are surfaced through the existing finance_alerts table rather than
-- a parallel alert system — see Insurance.tsx / Overview.tsx's alert flow.

CREATE TABLE IF NOT EXISTS public.insurance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_type text NOT NULL CHECK (policy_type IN ('health','life','term','vehicle','home','other')),
  provider text,
  policy_number text,
  sum_assured numeric(14,2),
  premium_amount numeric(14,2),
  premium_frequency text CHECK (premium_frequency IN ('monthly','quarterly','half_yearly','yearly','single')),
  start_date date,
  renewal_date date,
  nominee text,
  linked_account_id uuid REFERENCES public.financial_accounts(id) ON DELETE SET NULL,
  document_path text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE public.insurance_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner rw" ON public.insurance_policies FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.insurance_policies FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.insurance_policies TO authenticated;
GRANT ALL ON public.insurance_policies TO service_role;

CREATE INDEX IF NOT EXISTS insurance_policies_renewal_idx
  ON public.insurance_policies(user_id, renewal_date);
