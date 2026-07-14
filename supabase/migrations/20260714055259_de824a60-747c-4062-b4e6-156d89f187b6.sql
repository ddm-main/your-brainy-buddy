ALTER TABLE public.financial_accounts
  ADD COLUMN IF NOT EXISTS statement_password_rule jsonb;

ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS closing_balance numeric;