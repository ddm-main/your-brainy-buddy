
-- Category rules (learning engine)
CREATE TABLE public.category_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  match_type text NOT NULL CHECK (match_type IN ('merchant','contains','regex')),
  pattern text NOT NULL,
  category text NOT NULL,
  priority int NOT NULL DEFAULT 100,
  hits int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.category_rules TO authenticated;
GRANT ALL ON public.category_rules TO service_role;
ALTER TABLE public.category_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON public.category_rules FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX category_rules_user_priority_idx ON public.category_rules(user_id, priority DESC);
CREATE TRIGGER category_rules_updated BEFORE UPDATE ON public.category_rules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Merchant aliases
CREATE TABLE public.merchant_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  raw text NOT NULL,
  canonical text NOT NULL,
  category text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, raw)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchant_aliases TO authenticated;
GRANT ALL ON public.merchant_aliases TO service_role;
ALTER TABLE public.merchant_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON public.merchant_aliases FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER merchant_aliases_updated BEFORE UPDATE ON public.merchant_aliases FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Budgets
CREATE TABLE public.budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  category text NOT NULL,
  monthly_limit numeric NOT NULL CHECK (monthly_limit >= 0),
  rollover boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, category)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.budgets TO authenticated;
GRANT ALL ON public.budgets TO service_role;
ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON public.budgets FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER budgets_updated BEFORE UPDATE ON public.budgets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Finance suggestions (detector outputs)
CREATE TABLE public.finance_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('salary','investment','duplicate','anomaly','subscription','category_rule')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.finance_suggestions TO authenticated;
GRANT ALL ON public.finance_suggestions TO service_role;
ALTER TABLE public.finance_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON public.finance_suggestions FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX finance_suggestions_user_status_idx ON public.finance_suggestions(user_id, status, created_at DESC);
CREATE TRIGGER finance_suggestions_updated BEFORE UPDATE ON public.finance_suggestions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Finance reports (AI monthly)
CREATE TABLE public.finance_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period text NOT NULL,
  kind text NOT NULL DEFAULT 'monthly',
  body_md text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period, kind)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.finance_reports TO authenticated;
GRANT ALL ON public.finance_reports TO service_role;
ALTER TABLE public.finance_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON public.finance_reports FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
