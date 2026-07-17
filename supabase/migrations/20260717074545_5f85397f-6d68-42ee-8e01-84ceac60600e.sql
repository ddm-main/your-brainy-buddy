
-- 1) Collapse existing duplicates so the unique index can be created.
--    Pick the "best" row per (user_id, entity, statement_date) group:
--    parsed > everything else; then higher transactions_found; then newer.
WITH ranked AS (
  SELECT id, user_id, credit_card_id, financial_account_id, loan_id,
         statement_date, parse_status, transactions_found, created_at,
         row_number() OVER (
           PARTITION BY user_id,
             COALESCE(credit_card_id, '00000000-0000-0000-0000-000000000000'::uuid),
             COALESCE(financial_account_id, '00000000-0000-0000-0000-000000000000'::uuid),
             COALESCE(loan_id, '00000000-0000-0000-0000-000000000000'::uuid),
             statement_date
           ORDER BY
             CASE WHEN parse_status = 'parsed' THEN 0 ELSE 1 END,
             COALESCE(transactions_found, 0) DESC,
             created_at DESC
         ) AS rn
  FROM public.statements
  WHERE statement_date IS NOT NULL
    AND (credit_card_id IS NOT NULL OR financial_account_id IS NOT NULL OR loan_id IS NOT NULL)
),
losers AS (
  SELECT id FROM ranked WHERE rn > 1
)
DELETE FROM public.statements WHERE id IN (SELECT id FROM losers);

-- 2) Unique index: one statement per (user, entity, statement_date).
CREATE UNIQUE INDEX IF NOT EXISTS statements_entity_date_unique
  ON public.statements (
    user_id,
    COALESCE(credit_card_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(financial_account_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(loan_id, '00000000-0000-0000-0000-000000000000'::uuid),
    statement_date
  )
  WHERE statement_date IS NOT NULL
    AND (credit_card_id IS NOT NULL OR financial_account_id IS NOT NULL OR loan_id IS NOT NULL);

-- 3) Idempotency: one statement per source email.
CREATE UNIQUE INDEX IF NOT EXISTS statements_source_email_unique
  ON public.statements (user_id, source_email_id)
  WHERE source_email_id IS NOT NULL;

-- 4) Sync run log for diagnostics strip.
CREATE TABLE IF NOT EXISTS public.gmail_sync_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  account_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  scanned INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  statements_extracted INTEGER NOT NULL DEFAULT 0,
  txns_extracted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'cron',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.gmail_sync_runs TO authenticated;
GRANT ALL ON public.gmail_sync_runs TO service_role;

ALTER TABLE public.gmail_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gmail_sync_runs owner read"
  ON public.gmail_sync_runs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS gmail_sync_runs_account_started
  ON public.gmail_sync_runs (account_id, started_at DESC);
