CREATE TRIGGER trg_jarvis_memory_updated
  BEFORE UPDATE ON public.jarvis_memory
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS jarvis_memory_topic_pattern_idx
  ON public.jarvis_memory (topic text_pattern_ops);