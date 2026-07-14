ALTER TABLE public.statements DROP CONSTRAINT IF EXISTS statements_parser_source_check;
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_parser_source_check;

ALTER TABLE public.statements
  ADD CONSTRAINT statements_parser_source_check
  CHECK (parser_source IS NULL OR length(trim(parser_source)) BETWEEN 1 AND 80);

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_parser_source_check
  CHECK (parser_source IS NULL OR length(trim(parser_source)) BETWEEN 1 AND 80);