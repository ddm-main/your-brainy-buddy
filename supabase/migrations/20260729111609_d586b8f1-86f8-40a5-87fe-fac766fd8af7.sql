CREATE TABLE IF NOT EXISTS public.market_feed_heartbeat (
  feed_id text PRIMARY KEY,
  provider text NOT NULL,
  ok boolean NOT NULL DEFAULT true,
  latency_ms integer,
  detail text,
  symbols integer,
  observed_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.market_feed_heartbeat TO authenticated;
GRANT ALL ON public.market_feed_heartbeat TO service_role;

ALTER TABLE public.market_feed_heartbeat ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users can read feed heartbeat"
  ON public.market_feed_heartbeat FOR SELECT TO authenticated USING (true);