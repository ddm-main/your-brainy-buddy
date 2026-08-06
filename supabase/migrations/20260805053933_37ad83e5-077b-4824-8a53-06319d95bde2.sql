
ALTER TABLE public.market_live_price_stage
  ADD COLUMN IF NOT EXISTS market_cap_live numeric,
  ADD COLUMN IF NOT EXISTS quote_rejected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reject_reason text;

ALTER TABLE public.market_live_prices
  ADD COLUMN IF NOT EXISTS market_cap_live numeric,
  ADD COLUMN IF NOT EXISTS quote_rejected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reject_reason text;

CREATE INDEX IF NOT EXISTS market_stocks_series_active_idx
  ON public.market_stocks (series) WHERE is_active;

CREATE OR REPLACE FUNCTION public.begin_market_live_sweep(_sweep_id uuid, _session_date date, _as_of timestamp with time zone, _stale_after interval DEFAULT '00:04:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Coverage is measured against the mainboard universe the screener screens
  -- on. SME/Emerge (SM/ST) rows are quoted opportunistically but must not drag
  -- the promotion coverage ratio around.
  SELECT count(*) INTO _expected
    FROM public.market_stocks
   WHERE is_active = true AND exchange = 'NSE' AND instrument_type = 'EQ'
     AND coalesce(series, 'EQ') NOT IN ('SM', 'ST');
  INSERT INTO public.market_live_price_runs(sweep_id, session_date, as_of, expected_count)
  VALUES (_sweep_id, _session_date, _as_of, _expected);
  RETURN jsonb_build_object('started', true, 'expected_count', _expected, 'sweep_id', _sweep_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.promote_market_live_sweep(_sweep_id uuid, _min_coverage numeric DEFAULT 0.98)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _run public.market_live_price_runs%ROWTYPE;
  _priced integer;
  _coverage numeric;
  _removed integer;
  _rejected integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('market-live-sweep'));
  SELECT * INTO _run FROM public.market_live_price_runs WHERE sweep_id = _sweep_id FOR UPDATE;
  IF NOT FOUND OR _run.status <> 'running' THEN
    RETURN jsonb_build_object('promoted', false, 'reason', 'run_not_running');
  END IF;
  -- Coverage counts only mainboard, non-rejected quotes: a sweep that priced
  -- everything but flagged half of it is not a healthy sweep.
  SELECT count(*) INTO _priced
    FROM public.market_live_price_stage st
    JOIN public.market_stocks s ON s.symbol = st.symbol AND s.exchange = st.exchange
   WHERE st.sweep_id = _sweep_id AND st.ltp IS NOT NULL AND st.quote_rejected = false
     AND coalesce(s.series, 'EQ') NOT IN ('SM', 'ST');
  SELECT count(*) INTO _rejected
    FROM public.market_live_price_stage WHERE sweep_id = _sweep_id AND quote_rejected = true;
  _coverage := _priced::numeric / greatest(_run.expected_count, 1);
  IF _coverage < _min_coverage THEN
    UPDATE public.market_live_price_runs
       SET status = 'failed', priced_count = _priced,
           failed_count = greatest(expected_count - _priced, 0),
           completed_at = now(), error_message = 'coverage below promotion threshold'
     WHERE sweep_id = _sweep_id;
    RETURN jsonb_build_object('promoted', false, 'reason', 'coverage', 'priced', _priced, 'expected', _run.expected_count, 'coverage', _coverage, 'rejected', _rejected);
  END IF;

  INSERT INTO public.market_live_prices(symbol, exchange, session_date, ltp, prev_close, change_abs, change_pct, volume, provider, sweep_id, as_of, market_cap_live, quote_rejected, reject_reason, updated_at)
  SELECT symbol, exchange, session_date, ltp, prev_close, change_abs, change_pct, volume, provider, sweep_id, as_of, market_cap_live, quote_rejected, reject_reason, now()
    FROM public.market_live_price_stage WHERE sweep_id = _sweep_id AND ltp IS NOT NULL
  ON CONFLICT (symbol, exchange) DO UPDATE SET
    session_date = EXCLUDED.session_date, ltp = EXCLUDED.ltp, prev_close = EXCLUDED.prev_close,
    change_abs = EXCLUDED.change_abs, change_pct = EXCLUDED.change_pct, volume = EXCLUDED.volume,
    provider = EXCLUDED.provider, sweep_id = EXCLUDED.sweep_id, as_of = EXCLUDED.as_of,
    market_cap_live = EXCLUDED.market_cap_live, quote_rejected = EXCLUDED.quote_rejected,
    reject_reason = EXCLUDED.reject_reason, updated_at = now();

  DELETE FROM public.market_live_prices WHERE sweep_id <> _sweep_id;
  GET DIAGNOSTICS _removed = ROW_COUNT;

  UPDATE public.market_live_price_runs
     SET status = 'complete', priced_count = _priced,
         failed_count = greatest(expected_count - _priced, 0), completed_at = now()
   WHERE sweep_id = _sweep_id;
  DELETE FROM public.market_live_price_stage WHERE sweep_id <> _sweep_id;
  DELETE FROM public.market_live_price_runs
   WHERE status IN ('complete','failed') AND sweep_id <> _sweep_id
     AND started_at < now() - interval '2 days';
  RETURN jsonb_build_object('promoted', true, 'priced', _priced, 'expected', _run.expected_count,
                            'coverage', _coverage, 'evicted', _removed, 'rejected', _rejected);
END;
$function$;
