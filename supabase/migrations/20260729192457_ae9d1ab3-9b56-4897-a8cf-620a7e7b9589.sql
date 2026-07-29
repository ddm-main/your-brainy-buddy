ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS bars_available integer,
  ADD COLUMN IF NOT EXISTS pivot_touch_quality numeric,
  ADD COLUMN IF NOT EXISTS rel_volume_median30 numeric;

ALTER TABLE public.market_sector_strength_daily
  ADD COLUMN IF NOT EXISTS avg_ret_5d numeric,
  ADD COLUMN IF NOT EXISTS avg_ret_21d numeric,
  ADD COLUMN IF NOT EXISTS participation_delta numeric,
  ADD COLUMN IF NOT EXISTS blended_strength numeric;

CREATE TABLE IF NOT EXISTS public.market_score_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  trade_date date NOT NULL,
  model text NOT NULL DEFAULT 'breakout_v4',
  score integer,
  rank_pct numeric,
  band text,
  close numeric,
  buckets jsonb,
  coverage jsonb,
  fwd_ret_5d numeric,
  fwd_ret_10d numeric,
  fwd_ret_21d numeric,
  evaluated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, exchange, trade_date, model)
);

CREATE INDEX IF NOT EXISTS market_score_history_date_idx
  ON public.market_score_history (trade_date DESC, model);
CREATE INDEX IF NOT EXISTS market_score_history_pending_idx
  ON public.market_score_history (trade_date) WHERE fwd_ret_21d IS NULL;

GRANT SELECT ON public.market_score_history TO authenticated;
GRANT ALL ON public.market_score_history TO service_role;

ALTER TABLE public.market_score_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "score history readable by signed-in users"
  ON public.market_score_history FOR SELECT TO authenticated USING (true);