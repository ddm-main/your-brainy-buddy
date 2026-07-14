-- ============================================================
-- 1. Add user_id + missing columns
-- ============================================================
ALTER TABLE public.banks               ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.credit_cards        ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.financial_accounts  ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.loans               ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.email_accounts      ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.email_attachments   ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.statements          ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.transactions        ADD COLUMN IF NOT EXISTS user_id uuid;

-- statements: parser + due/balance fields the pipeline writes
ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS parse_error       text,
  ADD COLUMN IF NOT EXISTS parse_reason      text,
  ADD COLUMN IF NOT EXISTS parser_source     text,
  ADD COLUMN IF NOT EXISTS parser_confidence numeric,
  ADD COLUMN IF NOT EXISTS total_due         numeric,
  ADD COLUMN IF NOT EXISTS min_due           numeric,
  ADD COLUMN IF NOT EXISTS due_date          date,
  ADD COLUMN IF NOT EXISTS closing_balance   numeric,
  ADD COLUMN IF NOT EXISTS ai_summary        text,
  ADD COLUMN IF NOT EXISTS linked_bank_id    uuid;

-- email_accounts: finance routing flags
ALTER TABLE public.email_accounts
  ADD COLUMN IF NOT EXISTS use_case              text,
  ADD COLUMN IF NOT EXISTS finance_only          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sync_period_days      integer,
  ADD COLUMN IF NOT EXISTS treat_all_as_finance  boolean NOT NULL DEFAULT false;

-- financial_accounts: encrypted password rule for account statements
ALTER TABLE public.financial_accounts
  ADD COLUMN IF NOT EXISTS statement_password_rule jsonb;

-- loans: account_number for last-4 matching
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS account_number text;

-- email_attachments: statement linkage + size/mime fields the pipeline sets
ALTER TABLE public.email_attachments
  ADD COLUMN IF NOT EXISTS statement_id uuid,
  ADD COLUMN IF NOT EXISTS byte_size    integer,
  ADD COLUMN IF NOT EXISTS mime         text;

-- ============================================================
-- 2. jarvis_memory (topic/content store for password candidates etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.jarvis_memory (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  topic text NOT NULL,
  content text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, topic)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jarvis_memory TO authenticated;
GRANT ALL ON public.jarvis_memory TO service_role;
ALTER TABLE public.jarvis_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "jarvis_memory owner" ON public.jarvis_memory;
CREATE POLICY "jarvis_memory owner" ON public.jarvis_memory
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP TRIGGER IF EXISTS trg_jarvis_memory_updated ON public.jarvis_memory;
CREATE TRIGGER trg_jarvis_memory_updated
  BEFORE UPDATE ON public.jarvis_memory
  FOR EACH ROW EXECUTE FUNCTION public.jarvis_touch_updated_at();

-- ============================================================
-- 3. Rescope RLS policies to owner (was USING true)
-- ============================================================
DO $$
DECLARE
  t text;
  pol text;
BEGIN
  FOR t, pol IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN ('banks','credit_cards','financial_accounts','loans',
                        'email_accounts','email_attachments','statements','transactions')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)',
      pol || '_owner', t
    );
  END LOOP;
END $$;

-- ============================================================
-- 4. Onboard 07statement@gmail.com as dedicated forwarding inbox
-- ============================================================
UPDATE public.email_accounts
   SET use_case             = 'finance',
       finance_only         = true,
       treat_all_as_finance = true,
       sync_period_days     = GREATEST(COALESCE(sync_period_days, 30), 365)
 WHERE lower(email_address) = '07statement@gmail.com';

-- ============================================================
-- 5. Backfill hint rows for known SBI cards (no-op if none exist)
--    Marks pending/failed/skipped SBI-card statements with a
--    subject-inferred parser_source so the retry UI knows to try them.
-- ============================================================
UPDATE public.statements s
   SET parser_source = COALESCE(parser_source, 'sbi-card-subject'),
       parse_reason  = COALESCE(parse_reason,  'matched via subject+sender')
  FROM public.emails e
 WHERE s.source_email_id = e.id
   AND s.parse_status IN ('pending','failed','skipped')
   AND (
        lower(coalesce(e.from_email,'')) LIKE '%sbicard.com%'
     OR lower(coalesce(e.subject,''))    ~ 'bpcl|cashback|sbi\s*card'
   );

-- ============================================================
-- 6. Rows without a PDF attachment: skipped -> pending w/ reason
-- ============================================================
UPDATE public.statements
   SET parse_status = 'pending',
       parse_reason = COALESCE(parse_reason, 'no_pdf_attachment_login_required')
 WHERE parse_status = 'skipped'
   AND file_path IS NULL;

-- ============================================================
-- 7. Sync emails.linked_card_id / linked_bank_id from resolved statements
-- ============================================================
UPDATE public.emails e
   SET linked_card_id = COALESCE(e.linked_card_id, s.credit_card_id),
       linked_bank_id = COALESCE(e.linked_bank_id, s.bank_id)
  FROM public.statements s
 WHERE s.source_email_id = e.id
   AND (s.credit_card_id IS NOT NULL OR s.bank_id IS NOT NULL);