ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS bank_slug text;

CREATE INDEX IF NOT EXISTS idx_statements_user_bank_slug
  ON public.statements(user_id, bank_slug);