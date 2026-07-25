ALTER TABLE public.market_ticker_trace ADD COLUMN IF NOT EXISTS source text;
CREATE INDEX IF NOT EXISTS market_ticker_trace_created_at_idx ON public.market_ticker_trace (created_at DESC);
CREATE INDEX IF NOT EXISTS market_ticker_trace_source_idx ON public.market_ticker_trace (source, created_at DESC);