
ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS parse_reason text,
  ADD COLUMN IF NOT EXISTS parser_confidence numeric;

ALTER TABLE public.email_accounts
  ADD COLUMN IF NOT EXISTS treat_all_as_finance boolean NOT NULL DEFAULT false;

DELETE FROM public.banks
WHERE lower(name) = 'sbi'
  AND id <> '8cb1abfd-33d4-4f39-9aa3-d3dd05325986'
  AND NOT EXISTS (SELECT 1 FROM public.credit_cards       WHERE bank_id = public.banks.id)
  AND NOT EXISTS (SELECT 1 FROM public.financial_accounts WHERE bank_id = public.banks.id);

CREATE UNIQUE INDEX IF NOT EXISTS banks_name_lower_uidx
  ON public.banks (lower(name));
