DELETE FROM public.market_sweep_snapshot;

ALTER TABLE public.market_sweep_snapshot
  ADD COLUMN IF NOT EXISTS chunk_size integer NOT NULL DEFAULT 600;

CREATE UNIQUE INDEX IF NOT EXISTS market_sweep_snapshot_session_uk
  ON public.market_sweep_snapshot (session_date);