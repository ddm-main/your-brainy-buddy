
-- 1. statements: fields the parser/UI already writes but the deployed DB is missing.
ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS due_date   date,
  ADD COLUMN IF NOT EXISTS min_due    numeric,
  ADD COLUMN IF NOT EXISTS ai_summary text;

-- 2. email_attachments: link back to the statement row + track byte size.
ALTER TABLE public.email_attachments
  ADD COLUMN IF NOT EXISTS statement_id uuid REFERENCES public.statements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS byte_size    integer;

-- 3. Indexes for the ingestion + retry paths.
CREATE INDEX IF NOT EXISTS email_attachments_statement_idx
  ON public.email_attachments(statement_id);

CREATE INDEX IF NOT EXISTS statements_user_status_created_idx
  ON public.statements(user_id, parse_status, created_at DESC);

CREATE INDEX IF NOT EXISTS statements_source_email_idx
  ON public.statements(source_email_id);
