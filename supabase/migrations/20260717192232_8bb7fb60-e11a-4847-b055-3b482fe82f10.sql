
CREATE TABLE public.market_fundamentals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, exchange)
);
CREATE INDEX market_fundamentals_symbol_idx ON public.market_fundamentals (user_id, symbol, exchange);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_fundamentals TO authenticated;
GRANT ALL ON public.market_fundamentals TO service_role;
ALTER TABLE public.market_fundamentals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own fundamentals" ON public.market_fundamentals FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.market_option_chain_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  expiry date NOT NULL,
  underlying_price numeric,
  payload jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, expiry, captured_at)
);
CREATE INDEX market_option_chain_recent_idx ON public.market_option_chain_snapshots (user_id, symbol, captured_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_option_chain_snapshots TO authenticated;
GRANT ALL ON public.market_option_chain_snapshots TO service_role;
ALTER TABLE public.market_option_chain_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own option chain" ON public.market_option_chain_snapshots FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
