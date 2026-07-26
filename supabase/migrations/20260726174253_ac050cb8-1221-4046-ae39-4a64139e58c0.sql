
CREATE TABLE public.market_breakout_tracker (
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  first_detected_date date NOT NULL,
  entry_close numeric,
  detected_score numeric,
  peak_close numeric,
  peak_return_pct numeric,
  current_close numeric,
  current_return_pct numeric,
  days_tracked integer NOT NULL DEFAULT 1,
  last_score numeric,
  followthrough_score numeric,
  score_trend jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  below_threshold_days integer NOT NULL DEFAULT 0,
  sector text,
  market_cap numeric,
  last_evaluated_date date,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, exchange, first_detected_date)
);
CREATE INDEX market_breakout_tracker_status_idx ON public.market_breakout_tracker(status, first_detected_date DESC);

GRANT SELECT ON public.market_breakout_tracker TO authenticated;
GRANT ALL ON public.market_breakout_tracker TO service_role;

ALTER TABLE public.market_breakout_tracker ENABLE ROW LEVEL SECURITY;
CREATE POLICY "breakout_tracker_read" ON public.market_breakout_tracker
  FOR SELECT TO authenticated USING (true);

CREATE TRIGGER trg_market_breakout_tracker_updated_at
  BEFORE UPDATE ON public.market_breakout_tracker
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.market_breakout_snapshots (
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  trade_date date NOT NULL,
  breakout_score numeric,
  prebreakout_score numeric,
  swing_score numeric,
  close numeric,
  market_cap numeric,
  sector text,
  rel_volume numeric,
  regime text,
  components jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, exchange, trade_date)
);
CREATE INDEX market_breakout_snapshots_date_idx ON public.market_breakout_snapshots(trade_date DESC);

GRANT SELECT ON public.market_breakout_snapshots TO authenticated;
GRANT ALL ON public.market_breakout_snapshots TO service_role;

ALTER TABLE public.market_breakout_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "breakout_snapshots_read" ON public.market_breakout_snapshots
  FOR SELECT TO authenticated USING (true);
