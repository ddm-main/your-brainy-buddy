-- market-morning-insight had no cache and no rate limiter at all — every
-- call was a fresh, unbounded LLM spend despite being a "morning brief"
-- that should be idempotent within a day. One row per user per day, same
-- shape as the existing (finance-only) morning_briefs table, kept separate
-- since that table is already owned by finance-morning-brief.
CREATE TABLE public.market_morning_insight_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brief_date date NOT NULL,
  summary text NOT NULL,
  data jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, brief_date)
);
GRANT SELECT, INSERT, UPDATE ON public.market_morning_insight_cache TO authenticated;
GRANT ALL ON public.market_morning_insight_cache TO service_role;
ALTER TABLE public.market_morning_insight_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner rw market_morning_insight_cache" ON public.market_morning_insight_cache
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
