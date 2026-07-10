CREATE TABLE IF NOT EXISTS public.jarvis_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_text text NOT NULL,
  assistant_text text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT 'gemini',
  model text NOT NULL DEFAULT 'google/gemini-3-flash-preview',
  mode text NOT NULL DEFAULT 'text',
  latency_ms integer,
  screenshot_url text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jarvis_interactions TO anon, authenticated;
GRANT ALL ON public.jarvis_interactions TO service_role;
ALTER TABLE public.jarvis_interactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single-user open read" ON public.jarvis_interactions FOR SELECT USING (true);
CREATE POLICY "single-user open write" ON public.jarvis_interactions FOR INSERT WITH CHECK (true);
CREATE POLICY "single-user open update" ON public.jarvis_interactions FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "single-user open delete" ON public.jarvis_interactions FOR DELETE USING (true);
CREATE INDEX IF NOT EXISTS jarvis_interactions_created_idx ON public.jarvis_interactions (created_at DESC);