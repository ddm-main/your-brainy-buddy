
-- Payment status enum (card statements only; account/loan default to 'na')
DO $$ BEGIN
  CREATE TYPE public.statement_payment_status AS ENUM ('na','pending','paid','overdue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Skeletons: learned layout template per (user, bank, type, variant, fingerprint)
CREATE TABLE IF NOT EXISTS public.statement_skeletons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bank_slug text NOT NULL,
  statement_type public.statement_type NOT NULL,
  variant text,
  layout_fingerprint text NOT NULL,
  skeleton jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  sample_statement_id uuid,
  parse_success_count int NOT NULL DEFAULT 0,
  parse_failure_count int NOT NULL DEFAULT 0,
  learned_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS statement_skeletons_uniq
  ON public.statement_skeletons (user_id, bank_slug, statement_type, coalesce(variant,''), layout_fingerprint);
CREATE INDEX IF NOT EXISTS statement_skeletons_lookup
  ON public.statement_skeletons (user_id, bank_slug, statement_type);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.statement_skeletons TO authenticated;
GRANT ALL ON public.statement_skeletons TO service_role;

ALTER TABLE public.statement_skeletons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own skeletons"
  ON public.statement_skeletons FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_statement_skeletons_updated_at
  BEFORE UPDATE ON public.statement_skeletons
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Statements: link + card-only payment tracking
ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS skeleton_id uuid REFERENCES public.statement_skeletons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_status public.statement_payment_status NOT NULL DEFAULT 'na',
  ADD COLUMN IF NOT EXISTS paid_on date,
  ADD COLUMN IF NOT EXISTS paid_amount numeric;

-- Default card statements to 'pending' when they have a due_date; leave accounts/loans as 'na'.
UPDATE public.statements
   SET payment_status = 'pending'
 WHERE statement_type = 'card'
   AND payment_status = 'na'
   AND due_date IS NOT NULL;
