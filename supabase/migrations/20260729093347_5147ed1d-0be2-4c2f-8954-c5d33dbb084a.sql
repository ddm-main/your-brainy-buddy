CREATE TABLE public.market_feed_prefs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  feed_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, feed_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_feed_prefs TO authenticated;
GRANT ALL ON public.market_feed_prefs TO service_role;

ALTER TABLE public.market_feed_prefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own feed provider preferences"
ON public.market_feed_prefs FOR ALL TO authenticated
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_market_feed_prefs_updated_at
BEFORE UPDATE ON public.market_feed_prefs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();