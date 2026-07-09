
-- jarvis_memory
CREATE TABLE public.jarvis_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  content text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jarvis_memory TO anon, authenticated;
GRANT ALL ON public.jarvis_memory TO service_role;
ALTER TABLE public.jarvis_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Open access for personal OS" ON public.jarvis_memory
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE INDEX jarvis_memory_topic_idx ON public.jarvis_memory (topic);
CREATE TRIGGER jarvis_memory_updated_at
  BEFORE UPDATE ON public.jarvis_memory
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- jarvis_reminders
CREATE TABLE public.jarvis_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  fire_at timestamptz NOT NULL,
  fired boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jarvis_reminders TO anon, authenticated;
GRANT ALL ON public.jarvis_reminders TO service_role;
ALTER TABLE public.jarvis_reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Open access for personal OS" ON public.jarvis_reminders
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE INDEX jarvis_reminders_pending_idx ON public.jarvis_reminders (fire_at) WHERE fired = false;
