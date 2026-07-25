
ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS market_cap_source text,
  ADD COLUMN IF NOT EXISTS market_cap_as_of timestamptz;

CREATE TABLE IF NOT EXISTS public.market_value_audit (
  id           bigserial PRIMARY KEY,
  symbol       text NOT NULL,
  exchange     text NOT NULL DEFAULT 'NSE',
  field        text NOT NULL,
  our_value    numeric,
  ref_value    numeric,
  ref_source   text NOT NULL,
  delta_pct    numeric,
  checked_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_value_audit_symbol_field_idx
  ON public.market_value_audit (symbol, field, checked_at DESC);

GRANT SELECT ON public.market_value_audit TO authenticated;
GRANT ALL    ON public.market_value_audit TO service_role;
ALTER TABLE public.market_value_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit read for authed"
  ON public.market_value_audit FOR SELECT
  TO authenticated USING (true);
