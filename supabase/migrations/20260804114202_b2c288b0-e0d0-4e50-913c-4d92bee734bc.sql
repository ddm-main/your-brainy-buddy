CREATE TABLE public.market_live_price_runs (
  sweep_id uuid PRIMARY KEY,
  session_date date NOT NULL,
  as_of timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'running',
  expected_count integer NOT NULL DEFAULT 0,
  scanned_count integer NOT NULL DEFAULT 0,
  priced_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  kotak_count integer NOT NULL DEFAULT 0,
  yahoo_count integer NOT NULL DEFAULT 0,
  last_symbol text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.market_live_price_runs TO authenticated;
GRANT ALL ON public.market_live_price_runs TO service_role;
ALTER TABLE public.market_live_price_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "live sweep runs readable by authenticated" ON public.market_live_price_runs FOR SELECT TO authenticated USING (true);
CREATE TRIGGER market_live_price_runs_updated_at BEFORE UPDATE ON public.market_live_price_runs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX market_live_price_runs_status_idx ON public.market_live_price_runs (status, started_at DESC);

CREATE TABLE public.market_live_price_stage (
  sweep_id uuid NOT NULL REFERENCES public.market_live_price_runs(sweep_id) ON DELETE CASCADE,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  session_date date NOT NULL,
  ltp numeric,
  prev_close numeric,
  change_abs numeric,
  change_pct numeric,
  volume bigint,
  provider text,
  as_of timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sweep_id, symbol, exchange)
);
GRANT ALL ON public.market_live_price_stage TO service_role;
ALTER TABLE public.market_live_price_stage ENABLE ROW LEVEL SECURITY;
CREATE INDEX market_live_price_stage_sweep_idx ON public.market_live_price_stage (sweep_id);

CREATE OR REPLACE FUNCTION public.begin_market_live_sweep(
  _sweep_id uuid,
  _session_date date,
  _as_of timestamptz,
  _stale_after interval DEFAULT interval '4 minutes'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _expected integer;
  _running uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('market-live-sweep'));
  UPDATE public.market_live_price_runs
     SET status = 'failed', error_message = 'stale sweep superseded', completed_at = now()
   WHERE status = 'running' AND started_at < now() - _stale_after;
  SELECT sweep_id INTO _running FROM public.market_live_price_runs WHERE status = 'running' LIMIT 1;
  IF _running IS NOT NULL THEN
    RETURN jsonb_build_object('started', false, 'reason', 'overlap', 'sweep_id', _running);
  END IF;
  SELECT count(*) INTO _expected
    FROM public.market_stocks
   WHERE is_active = true AND exchange = 'NSE' AND instrument_type = 'EQ';
  INSERT INTO public.market_live_price_runs(sweep_id, session_date, as_of, expected_count)
  VALUES (_sweep_id, _session_date, _as_of, _expected);
  RETURN jsonb_build_object('started', true, 'expected_count', _expected, 'sweep_id', _sweep_id);
END;
$$;
REVOKE ALL ON FUNCTION public.begin_market_live_sweep(uuid,date,timestamptz,interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_market_live_sweep(uuid,date,timestamptz,interval) TO service_role;

CREATE OR REPLACE FUNCTION public.promote_market_live_sweep(
  _sweep_id uuid,
  _min_coverage numeric DEFAULT 0.98
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _run public.market_live_price_runs%ROWTYPE;
  _priced integer;
  _coverage numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('market-live-sweep'));
  SELECT * INTO _run FROM public.market_live_price_runs WHERE sweep_id = _sweep_id FOR UPDATE;
  IF NOT FOUND OR _run.status <> 'running' THEN
    RETURN jsonb_build_object('promoted', false, 'reason', 'run_not_running');
  END IF;
  SELECT count(*) INTO _priced FROM public.market_live_price_stage WHERE sweep_id = _sweep_id AND ltp IS NOT NULL;
  _coverage := _priced::numeric / greatest(_run.expected_count, 1);
  IF _coverage < _min_coverage THEN
    UPDATE public.market_live_price_runs
       SET status = 'failed', priced_count = _priced,
           failed_count = greatest(expected_count - _priced, 0),
           completed_at = now(), error_message = 'coverage below promotion threshold'
     WHERE sweep_id = _sweep_id;
    RETURN jsonb_build_object('promoted', false, 'reason', 'coverage', 'priced', _priced, 'expected', _run.expected_count, 'coverage', _coverage);
  END IF;
  INSERT INTO public.market_live_prices(symbol, exchange, session_date, ltp, prev_close, change_abs, change_pct, volume, provider, sweep_id, as_of, updated_at)
  SELECT symbol, exchange, session_date, ltp, prev_close, change_abs, change_pct, volume, provider, sweep_id, as_of, now()
    FROM public.market_live_price_stage WHERE sweep_id = _sweep_id AND ltp IS NOT NULL
  ON CONFLICT (symbol, exchange) DO UPDATE SET
    session_date = EXCLUDED.session_date, ltp = EXCLUDED.ltp, prev_close = EXCLUDED.prev_close,
    change_abs = EXCLUDED.change_abs, change_pct = EXCLUDED.change_pct, volume = EXCLUDED.volume,
    provider = EXCLUDED.provider, sweep_id = EXCLUDED.sweep_id, as_of = EXCLUDED.as_of, updated_at = now();
  UPDATE public.market_live_price_runs
     SET status = 'complete', priced_count = _priced,
         failed_count = greatest(expected_count - _priced, 0), completed_at = now()
   WHERE sweep_id = _sweep_id;
  DELETE FROM public.market_live_price_stage WHERE sweep_id <> _sweep_id;
  DELETE FROM public.market_live_price_runs
   WHERE status IN ('complete','failed') AND sweep_id <> _sweep_id
     AND started_at < now() - interval '2 days';
  RETURN jsonb_build_object('promoted', true, 'priced', _priced, 'expected', _run.expected_count, 'coverage', _coverage);
END;
$$;
REVOKE ALL ON FUNCTION public.promote_market_live_sweep(uuid,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_market_live_sweep(uuid,numeric) TO service_role;

CREATE OR REPLACE VIEW public.market_live_price_status AS
SELECT sweep_id, session_date, as_of, expected_count, priced_count, failed_count,
       kotak_count, yahoo_count, completed_at,
       CASE WHEN expected_count > 0 THEN priced_count::numeric / expected_count ELSE 0 END AS coverage
  FROM public.market_live_price_runs
 WHERE status = 'complete'
 ORDER BY completed_at DESC
 LIMIT 1;
GRANT SELECT ON public.market_live_price_status TO authenticated;
GRANT SELECT ON public.market_live_price_status TO service_role;