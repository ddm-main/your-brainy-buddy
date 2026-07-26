ALTER TABLE public.market_saved_screeners
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'both'
  CHECK (scope IN ('stocks','breakout','both'));

UPDATE public.market_saved_screeners SET scope = 'both' WHERE scope IS NULL;