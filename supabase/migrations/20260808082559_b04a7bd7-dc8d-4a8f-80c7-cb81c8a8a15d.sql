CREATE OR REPLACE FUNCTION public.promote_market_live_sweep(_sweep_id uuid, _min_coverage numeric DEFAULT 0.98)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _run public.market_live_price_runs%ROWTYPE;
  _priced integer;
  _coverage numeric;
  _removed integer := 0;
  _rejected integer;
  _partial_floor numeric := 0.50;
  _mode text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('market-live-sweep'));
  SELECT * INTO _run FROM public.market_live_price_runs WHERE sweep_id = _sweep_id FOR UPDATE;
  IF NOT FOUND OR _run.status <> 'running' THEN
    RETURN jsonb_build_object('promoted', false, 'reason', 'run_not_running');
  END IF;

  -- Same plane as begin_market_live_sweep: mainboard, non-penny, non-rejected.
  SELECT count(*) INTO _priced
    FROM public.market_live_price_stage st
    JOIN public.market_stocks s ON s.symbol = st.symbol AND s.exchange = st.exchange
   WHERE st.sweep_id = _sweep_id AND st.ltp IS NOT NULL AND st.quote_rejected = false
     AND coalesce(s.series, 'EQ') NOT IN ('SM', 'ST')
     AND coalesce(s.penny_excluded, false) = false;

  SELECT count(*) INTO _rejected
    FROM public.market_live_price_stage WHERE sweep_id = _sweep_id AND quote_rejected = true;

  _coverage := _priced::numeric / greatest(_run.expected_count, 1);

  IF _coverage >= _min_coverage THEN
    _mode := 'full';
  ELSIF _coverage >= _partial_floor THEN
    -- A broker outage must not freeze the entire plane for days. Publish what
    -- was actually priced and keep the previous rows for everything else,
    -- rather than failing the run and leaving the UI on a week-old session.
    _mode := 'partial';
  ELSE
    _mode := 'failed';
  END IF;

  IF _mode = 'failed' THEN
    UPDATE public.market_live_price_runs
       SET status = 'failed', priced_count = _priced,
           failed_count = greatest(expected_count - _priced, 0),
           completed_at = now(),
           error_message = format('coverage below promotion floor (%s/%s = %s)', _priced, _run.expected_count, round(_coverage, 4))
     WHERE sweep_id = _sweep_id;
    DELETE FROM public.market_live_price_stage WHERE sweep_id = _sweep_id;
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

  -- Only a full sweep owns the whole plane and may prune stragglers.
  IF _mode = 'full' THEN
    DELETE FROM public.market_live_prices WHERE sweep_id <> _sweep_id;
    GET DIAGNOSTICS _removed = ROW_COUNT;
  END IF;

  UPDATE public.market_live_price_runs
     SET status = CASE WHEN _mode = 'full' THEN 'complete' ELSE 'partial' END,
         priced_count = _priced,
         failed_count = greatest(expected_count - _priced, 0),
         completed_at = now(),
         error_message = CASE WHEN _mode = 'full' THEN NULL
           ELSE format('partial promotion (%s/%s = %s)', _priced, _run.expected_count, round(_coverage, 4)) END
   WHERE sweep_id = _sweep_id;

  DELETE FROM public.market_live_price_stage WHERE sweep_id = _sweep_id;

  RETURN jsonb_build_object('promoted', true, 'mode', _mode, 'priced', _priced, 'expected', _run.expected_count, 'coverage', _coverage, 'rejected', _rejected, 'pruned', _removed);
END;
$$;