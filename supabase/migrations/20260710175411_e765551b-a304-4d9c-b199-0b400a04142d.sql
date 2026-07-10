
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS source_email_id uuid REFERENCES public.emails(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_ref text,
  ADD COLUMN IF NOT EXISTS confidence numeric;

CREATE INDEX IF NOT EXISTS transactions_source_email_id_idx ON public.transactions(source_email_id);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_source_email_unique ON public.transactions(user_id, source_email_id) WHERE source_email_id IS NOT NULL;

ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS confidence numeric;

CREATE UNIQUE INDEX IF NOT EXISTS statements_source_email_unique ON public.statements(user_id, source_email_id) WHERE source_email_id IS NOT NULL;
