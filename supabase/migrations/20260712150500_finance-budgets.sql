-- Per-category monthly budgets. Spend-so-far is computed live from
-- transactions (same convention as credit_cards' utilization — the source
-- of truth stays in one place) rather than stored/synced here.

CREATE TABLE IF NOT EXISTS public.budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  monthly_limit numeric(14,2) NOT NULL,
  period_start date NOT NULL DEFAULT date_trunc('month', current_date)::date,
  rollover boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner rw" ON public.budgets FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.budgets FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.budgets TO authenticated;
GRANT ALL ON public.budgets TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS budgets_user_category_key ON public.budgets (user_id, category);
