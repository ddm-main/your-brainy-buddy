
-- Scoring v2 inputs on the daily scores row.
ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS base_tightness numeric,
  ADD COLUMN IF NOT EXISTS dist_to_resistance_atr numeric,
  ADD COLUMN IF NOT EXISTS dist_from_pivot_atr numeric,
  ADD COLUMN IF NOT EXISTS rs_percentile_nifty smallint,
  ADD COLUMN IF NOT EXISTS price_source text;

-- Supporting index for AI-recommend / Top Breakouts ordering.
CREATE INDEX IF NOT EXISTS idx_market_stock_scores_breakout_score_desc
  ON public.market_stock_scores (trade_date DESC, breakout_score DESC NULLS LAST);

-- Calibration table: fitted per-component weights, loaded by scoring.ts.
CREATE TABLE IF NOT EXISTS public.market_scoring_calibration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version text NOT NULL,
  component text NOT NULL,
  weight numeric NOT NULL,
  r2 numeric,
  sample_n integer,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_version, component)
);

GRANT SELECT ON public.market_scoring_calibration TO authenticated;
GRANT ALL ON public.market_scoring_calibration TO service_role;

ALTER TABLE public.market_scoring_calibration ENABLE ROW LEVEL SECURITY;

CREATE POLICY "calibration readable by authenticated"
  ON public.market_scoring_calibration FOR SELECT
  TO authenticated USING (true);
