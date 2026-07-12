
ALTER TABLE public.financial_accounts
  ADD COLUMN IF NOT EXISTS current_balance numeric;

ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS total_due numeric,
  ADD COLUMN IF NOT EXISTS parser_source text;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS parser_source text;

ALTER TABLE public.jarvis_actions
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS expected_date date,
  ADD COLUMN IF NOT EXISTS message text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'statements_parser_source_check'
  ) THEN
    ALTER TABLE public.statements
      ADD CONSTRAINT statements_parser_source_check
      CHECK (parser_source IS NULL OR parser_source IN ('regex','ai','manual'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_parser_source_check'
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_parser_source_check
      CHECK (parser_source IS NULL OR parser_source IN ('regex','ai','manual'));
  END IF;
END $$;
