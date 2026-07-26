CREATE TABLE public.market_screener_favorites (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  filter_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, filter_id)
);
CREATE INDEX market_screener_favorites_user_idx ON public.market_screener_favorites(user_id, sort_order);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_screener_favorites TO authenticated;
GRANT ALL ON public.market_screener_favorites TO service_role;
ALTER TABLE public.market_screener_favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own favorites" ON public.market_screener_favorites
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);