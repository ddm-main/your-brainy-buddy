
-- 1. Authoritative NSE bhavcopy EOD
CREATE TABLE public.market_eod_nse (
  symbol text NOT NULL,
  trade_date date NOT NULL,
  series text,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  prev_close numeric,
  volume bigint,
  traded_value numeric,
  delivery_qty bigint,
  delivery_pct numeric,
  source text NOT NULL DEFAULT 'nse_bhavcopy',
  source_hash text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, trade_date)
);
CREATE INDEX market_eod_nse_trade_date_idx ON public.market_eod_nse (trade_date DESC);
GRANT SELECT ON public.market_eod_nse TO authenticated;
GRANT ALL ON public.market_eod_nse TO service_role;
ALTER TABLE public.market_eod_nse ENABLE ROW LEVEL SECURITY;
CREATE POLICY "eod_nse_read_authenticated" ON public.market_eod_nse FOR SELECT TO authenticated USING (true);

-- 2. NSE securities master (universe source of truth)
CREATE TABLE public.market_nse_master (
  symbol text PRIMARY KEY,
  isin text,
  company_name text,
  series text,
  face_value numeric,
  listing_date date,
  is_active boolean NOT NULL DEFAULT true,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_nse_master_isin_idx ON public.market_nse_master (isin);
GRANT SELECT ON public.market_nse_master TO authenticated;
GRANT ALL ON public.market_nse_master TO service_role;
ALTER TABLE public.market_nse_master ENABLE ROW LEVEL SECURITY;
CREATE POLICY "nse_master_read_authenticated" ON public.market_nse_master FOR SELECT TO authenticated USING (true);

-- 3. Shares outstanding, daily
CREATE TABLE public.market_shares_outstanding (
  symbol text NOT NULL,
  as_of date NOT NULL,
  total_shares numeric,
  free_float_shares numeric,
  source text NOT NULL,
  source_hash text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, as_of)
);
CREATE INDEX market_shares_outstanding_symbol_idx ON public.market_shares_outstanding (symbol, as_of DESC);
GRANT SELECT ON public.market_shares_outstanding TO authenticated;
GRANT ALL ON public.market_shares_outstanding TO service_role;
ALTER TABLE public.market_shares_outstanding ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shares_outstanding_read_authenticated" ON public.market_shares_outstanding FOR SELECT TO authenticated USING (true);

-- 4. Ingestion runs audit
CREATE TABLE public.market_ingestion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL,
  trade_date date,
  rows_ingested integer,
  duration_ms integer,
  error_message text,
  metadata jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX market_ingestion_runs_started_at_idx ON public.market_ingestion_runs (started_at DESC);
CREATE INDEX market_ingestion_runs_source_idx ON public.market_ingestion_runs (source, started_at DESC);
GRANT SELECT ON public.market_ingestion_runs TO authenticated;
GRANT ALL ON public.market_ingestion_runs TO service_role;
ALTER TABLE public.market_ingestion_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ingestion_runs_read_authenticated" ON public.market_ingestion_runs FOR SELECT TO authenticated USING (true);

-- 5. Per-ticker trace log
CREATE TABLE public.market_ticker_trace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  trade_date date NOT NULL,
  stage text NOT NULL,
  input_hash text,
  output_hash text,
  params jsonb,
  duration_ms integer,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_ticker_trace_symbol_idx ON public.market_ticker_trace (symbol, trade_date DESC, stage);
CREATE INDEX market_ticker_trace_created_idx ON public.market_ticker_trace (created_at DESC);
GRANT SELECT ON public.market_ticker_trace TO authenticated;
GRANT ALL ON public.market_ticker_trace TO service_role;
ALTER TABLE public.market_ticker_trace ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ticker_trace_read_authenticated" ON public.market_ticker_trace FOR SELECT TO authenticated USING (true);

-- updated_at triggers
CREATE TRIGGER market_eod_nse_touch BEFORE UPDATE ON public.market_eod_nse
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER market_nse_master_touch BEFORE UPDATE ON public.market_nse_master
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER market_shares_outstanding_touch BEFORE UPDATE ON public.market_shares_outstanding
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Retention: purge trace older than 14 days
CREATE OR REPLACE FUNCTION public.purge_old_ticker_trace()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.market_ticker_trace WHERE created_at < now() - interval '14 days';
$$;
