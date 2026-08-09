CREATE TABLE IF NOT EXISTS public.corporate_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  action_type text NOT NULL,
  ex_date date NOT NULL,
  ratio_from numeric,
  ratio_to numeric,
  amount numeric,
  purpose text,
  source text NOT NULL DEFAULT 'nse',
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.corporate_actions TO authenticated;
GRANT ALL ON public.corporate_actions TO service_role;

ALTER TABLE public.corporate_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read corporate actions"
  ON public.corporate_actions FOR SELECT TO authenticated USING (true);

CREATE UNIQUE INDEX IF NOT EXISTS uq_corp_actions_natural
  ON public.corporate_actions (symbol, exchange, action_type, ex_date);
CREATE INDEX IF NOT EXISTS corporate_actions_unapplied_idx
  ON public.corporate_actions (ex_date) WHERE applied_at IS NULL;
CREATE INDEX IF NOT EXISTS corporate_actions_ex_date_idx
  ON public.corporate_actions (ex_date DESC);

CREATE TRIGGER update_corporate_actions_updated_at
  BEFORE UPDATE ON public.corporate_actions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();