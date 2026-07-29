ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS breakout_score_v4 integer,
  ADD COLUMN IF NOT EXISTS breakout_v4_components jsonb,
  ADD COLUMN IF NOT EXISTS breakout_v4_coverage jsonb,
  ADD COLUMN IF NOT EXISTS breakout_v4_rank_pct numeric,
  ADD COLUMN IF NOT EXISTS score_unavailable_reason text;

CREATE INDEX IF NOT EXISTS market_stock_scores_trade_date_idx
  ON public.market_stock_scores (trade_date);

CREATE TABLE IF NOT EXISTS public.market_score_distribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_date date NOT NULL,
  model text NOT NULL DEFAULT 'breakout_v4',
  n integer NOT NULL DEFAULT 0,
  p50 numeric,
  p70 numeric,
  p90 numeric,
  max numeric,
  strong_cut numeric,
  moderate_cut numeric,
  watch_cut numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_date, model)
);

GRANT SELECT ON public.market_score_distribution TO authenticated;
GRANT ALL ON public.market_score_distribution TO service_role;

ALTER TABLE public.market_score_distribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY "score distribution readable by signed-in users"
  ON public.market_score_distribution FOR SELECT TO authenticated USING (true);

CREATE TRIGGER update_market_score_distribution_updated_at
  BEFORE UPDATE ON public.market_score_distribution
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();