
-- Indexes for jarvis_memory / jarvis_reminders performance + updated_at trigger for memory

CREATE INDEX IF NOT EXISTS jarvis_memory_topic_idx ON public.jarvis_memory (topic);
CREATE INDEX IF NOT EXISTS jarvis_memory_updated_idx ON public.jarvis_memory (updated_at DESC);
CREATE INDEX IF NOT EXISTS jarvis_reminders_pending_idx ON public.jarvis_reminders (fire_at) WHERE fired = false;

DROP TRIGGER IF EXISTS jarvis_memory_updated_at ON public.jarvis_memory;
CREATE TRIGGER jarvis_memory_updated_at
BEFORE UPDATE ON public.jarvis_memory
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Ensure grants (idempotent)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jarvis_memory TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jarvis_reminders TO anon, authenticated;
GRANT ALL ON public.jarvis_memory TO service_role;
GRANT ALL ON public.jarvis_reminders TO service_role;
