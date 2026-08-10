CREATE TABLE public.market_sweep_snapshot (
  sweep_id uuid PRIMARY KEY,
  session_date date NOT NULL,
  chunk_count integer NOT NULL DEFAULT 0,
  symbol_count integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '6 hours'
);

CREATE INDEX market_sweep_snapshot_expires_idx ON public.market_sweep_snapshot (expires_at);

GRANT ALL ON public.market_sweep_snapshot TO service_role;

ALTER TABLE public.market_sweep_snapshot ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sweep snapshot is service-only"
  ON public.market_sweep_snapshot
  FOR ALL
  USING (false)
  WITH CHECK (false);