
CREATE TABLE IF NOT EXISTS public.market_stock_ai (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_stock_ai_lookup_idx
  ON public.market_stock_ai (symbol, exchange, computed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_stock_ai TO authenticated;
GRANT ALL ON public.market_stock_ai TO service_role;

ALTER TABLE public.market_stock_ai ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read stock ai" ON public.market_stock_ai
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "own writes" ON public.market_stock_ai
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own updates" ON public.market_stock_ai
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own deletes" ON public.market_stock_ai
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
