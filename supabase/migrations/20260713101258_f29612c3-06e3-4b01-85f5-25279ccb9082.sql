
-- market_quotes: shared, read-any-authenticated, service-role writes only.
CREATE TABLE IF NOT EXISTS public.market_quotes (
  symbol text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('index','stock','fx','commodity','crypto')),
  price numeric(18,4) NOT NULL,
  change_abs numeric(18,4),
  change_pct numeric(8,4),
  currency text NOT NULL DEFAULT 'INR',
  source text NOT NULL DEFAULT 'yahoo',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.market_quotes TO authenticated;
GRANT ALL ON public.market_quotes TO service_role;
ALTER TABLE public.market_quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read market_quotes" ON public.market_quotes
  FOR SELECT TO authenticated USING (true);
CREATE TRIGGER trg_market_quotes_updated BEFORE UPDATE ON public.market_quotes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- market_news: shared headlines (source: RSS / NSE unofficial).
CREATE TABLE IF NOT EXISTS public.market_news (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  headline text NOT NULL,
  url text,
  source text,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.market_news TO authenticated;
GRANT ALL ON public.market_news TO service_role;
ALTER TABLE public.market_news ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read market_news" ON public.market_news
  FOR SELECT TO authenticated USING (true);
CREATE INDEX IF NOT EXISTS market_news_pub_idx ON public.market_news(published_at DESC);

-- fii_dii_activity: shared daily flow snapshot.
CREATE TABLE IF NOT EXISTS public.fii_dii_activity (
  activity_date date PRIMARY KEY,
  fii_net numeric(18,2),
  dii_net numeric(18,2),
  source text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.fii_dii_activity TO authenticated;
GRANT ALL ON public.fii_dii_activity TO service_role;
ALTER TABLE public.fii_dii_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read fii_dii" ON public.fii_dii_activity
  FOR SELECT TO authenticated USING (true);

-- morning_briefs: one per user per day, cached.
CREATE TABLE IF NOT EXISTS public.morning_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_date date NOT NULL,
  summary text NOT NULL,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  UNIQUE (user_id, brief_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.morning_briefs TO authenticated;
GRANT ALL ON public.morning_briefs TO service_role;
ALTER TABLE public.morning_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner rw morning_briefs" ON public.morning_briefs FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS morning_briefs_user_date_idx
  ON public.morning_briefs(user_id, brief_date DESC);
CREATE TRIGGER trg_morning_briefs_updated BEFORE UPDATE ON public.morning_briefs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- transactions: additive columns for detector output. Owner-scoped RLS unchanged.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS merchant_normalized text,
  ADD COLUMN IF NOT EXISTS is_duplicate boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_suspicious boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS transactions_merchant_norm_idx
  ON public.transactions(user_id, merchant_normalized)
  WHERE merchant_normalized IS NOT NULL;

-- statements: parser confidence alongside existing parse_error.
ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS parse_confidence numeric(4,2);
