-- Breakout section: daily detection + multi-day forward tracking.
--
-- market_stock_scores is overwritten every pipeline run (onConflict
-- symbol,exchange), so there is no per-symbol score history — "how did this
-- breakout pick do since detection" is unanswerable. These two tables add the
-- durable persistence the Breakout section needs, written by
-- market-pipeline-aggregates after its final rescoring pass.
--
-- Global tables (not user-scoped): same RLS shape as market_stock_scores /
-- market_breadth_daily — authenticated reads all rows, only service_role writes.
-- Idempotent so applying via MCP and later `db push` of this file don't collide.

-- Per-symbol daily score history for qualifying breakouts. Feeds the
-- score-trend sparkline and forward-return math. Append one row per
-- (symbol, exchange, trade_date).
CREATE TABLE IF NOT EXISTS public.market_breakout_snapshots (
  symbol            text NOT NULL,
  exchange          text NOT NULL,
  trade_date        date NOT NULL,
  breakout_score    integer,
  prebreakout_score integer,
  swing_score       integer,
  close             numeric,
  market_cap        numeric,
  sector            text,
  rel_volume        numeric,
  regime            text,
  components        jsonb,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, exchange, trade_date)
);
CREATE INDEX IF NOT EXISTS market_breakout_snapshots_sym_date_idx
  ON public.market_breakout_snapshots (symbol, exchange, trade_date DESC);
CREATE INDEX IF NOT EXISTS market_breakout_snapshots_date_idx
  ON public.market_breakout_snapshots (trade_date DESC);

GRANT SELECT ON public.market_breakout_snapshots TO authenticated;
GRANT ALL ON public.market_breakout_snapshots TO service_role;
ALTER TABLE public.market_breakout_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read market_breakout_snapshots" ON public.market_breakout_snapshots;
CREATE POLICY "read market_breakout_snapshots" ON public.market_breakout_snapshots
  FOR SELECT TO authenticated USING (true);

-- One episode per (symbol, first_detected_date). The object the Breakout UI
-- lists. Re-evaluated every pipeline run: forward return vs entry, peak,
-- score trend, and a lifecycle status. A symbol re-qualifying after its
-- episode closes opens a fresh row (new first_detected_date).
CREATE TABLE IF NOT EXISTS public.market_breakout_tracker (
  symbol               text NOT NULL,
  exchange             text NOT NULL,
  first_detected_date  date NOT NULL,
  entry_close          numeric,
  detected_score       integer,
  peak_close           numeric,
  peak_return_pct      numeric,
  current_close        numeric,
  current_return_pct   numeric,
  days_tracked         integer NOT NULL DEFAULT 1,
  last_score           integer,
  followthrough_score  integer,
  -- recent breakout scores oldest→newest, capped ~15 in the pipeline
  score_trend          integer[] NOT NULL DEFAULT '{}',
  -- active | extended | cooled | failed | closed
  status               text NOT NULL DEFAULT 'active',
  -- consecutive sessions the score has sat below the qualify threshold
  below_threshold_days integer NOT NULL DEFAULT 0,
  sector               text,
  market_cap           numeric,
  last_evaluated_date  date,
  closed_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, exchange, first_detected_date)
);
-- Hot-list index: the UI's default view is open episodes only.
CREATE INDEX IF NOT EXISTS market_breakout_tracker_open_idx
  ON public.market_breakout_tracker (status, first_detected_date DESC)
  WHERE status IN ('active', 'extended', 'cooled');

GRANT SELECT ON public.market_breakout_tracker TO authenticated;
GRANT ALL ON public.market_breakout_tracker TO service_role;
ALTER TABLE public.market_breakout_tracker ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read market_breakout_tracker" ON public.market_breakout_tracker;
CREATE POLICY "read market_breakout_tracker" ON public.market_breakout_tracker
  FOR SELECT TO authenticated USING (true);
