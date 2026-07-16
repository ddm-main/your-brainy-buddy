ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS manual_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_override_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_fields jsonb;

ALTER TABLE public.statement_skeletons
  ADD COLUMN IF NOT EXISTS field_hints jsonb;