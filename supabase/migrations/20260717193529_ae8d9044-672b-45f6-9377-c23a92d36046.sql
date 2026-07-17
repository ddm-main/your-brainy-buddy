-- Fundamentals summary columns on market_stocks
ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS sector text,
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS market_cap numeric,
  ADD COLUMN IF NOT EXISTS pe_ttm numeric,
  ADD COLUMN IF NOT EXISTS roe numeric,
  ADD COLUMN IF NOT EXISTS next_earnings_at timestamptz;

-- Option chain snapshots (per user, per expiry)
CREATE TABLE IF NOT EXISTS public.market_option_chain_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  expiry date NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS market_option_chain_snapshots_lookup
  ON public.market_option_chain_snapshots (user_id, symbol, expiry, captured_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_option_chain_snapshots TO authenticated;
GRANT ALL ON public.market_option_chain_snapshots TO service_role;
ALTER TABLE public.market_option_chain_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own option snapshots" ON public.market_option_chain_snapshots
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Score expansion: fundamentals + option flow + depth signal
ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS pcr numeric,
  ADD COLUMN IF NOT EXISTS iv_rank numeric,
  ADD COLUMN IF NOT EXISTS depth_imbalance numeric,
  ADD COLUMN IF NOT EXISTS pe_ttm numeric,
  ADD COLUMN IF NOT EXISTS roe numeric,
  ADD COLUMN IF NOT EXISTS revenue_growth numeric;