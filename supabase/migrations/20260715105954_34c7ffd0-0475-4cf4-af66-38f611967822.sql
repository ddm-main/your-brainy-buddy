
ALTER TABLE public.statement_skeletons
  ADD COLUMN IF NOT EXISTS structural_fingerprint text,
  ADD COLUMN IF NOT EXISTS last_learn_at timestamptz;

CREATE INDEX IF NOT EXISTS statement_skeletons_structural_idx
  ON public.statement_skeletons(user_id, bank_slug, statement_type, structural_fingerprint);

ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS last_learn_at timestamptz;

ALTER TABLE public.credit_cards
  ADD COLUMN IF NOT EXISTS latest_statement_id uuid REFERENCES public.statements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS latest_due_date date,
  ADD COLUMN IF NOT EXISTS latest_total_due numeric,
  ADD COLUMN IF NOT EXISTS latest_min_due numeric,
  ADD COLUMN IF NOT EXISTS payment_status text;
