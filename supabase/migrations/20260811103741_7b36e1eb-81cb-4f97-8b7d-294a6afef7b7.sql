ALTER TABLE public.market_sweep_snapshot
  ADD COLUMN IF NOT EXISTS snapshot_version integer NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.market_live_sweep_universe()
RETURNS TABLE(symbol text, yahoo_symbol text, series text, total_shares_cr numeric, token text, kotak_segment text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH slugs AS (
    SELECT DISTINCT CASE upper(regexp_replace(coalesce(w.constituents_slug,''), '[^a-zA-Z0-9]', '', 'g'))
      WHEN 'NIFTYBANK' THEN 'BANKNIFTY'
      ELSE upper(regexp_replace(coalesce(w.constituents_slug,''), '[^a-zA-Z0-9]', '', 'g'))
    END AS key
    FROM public.market_index_watch w
    WHERE coalesce(w.constituents_slug,'') <> ''
  ), watched AS (
    SELECT DISTINCT upper(s) AS symbol FROM (
      SELECT symbol AS s FROM public.market_watchlist_items
      UNION ALL SELECT symbol FROM public.market_holdings WHERE quantity > 0
      UNION ALL SELECT symbol FROM public.market_positions WHERE closed_at IS NULL
      UNION ALL SELECT symbol FROM public.market_gtt_orders WHERE status IN ('pending','active','armed')
      UNION ALL SELECT symbol FROM public.market_alerts WHERE is_active
      UNION ALL SELECT symbol FROM public.market_autotrade_rules WHERE is_armed AND symbol IS NOT NULL
      UNION ALL SELECT m.symbol FROM public.market_index_members m JOIN slugs g ON g.key = upper(m.index_key)
    ) t WHERE s IS NOT NULL AND length(s) > 0
  )
  SELECT s.symbol, s.yahoo_symbol, s.series, s.total_shares_cr, s.token, s.kotak_segment
  FROM public.market_stocks s
  LEFT JOIN watched w ON w.symbol = upper(s.symbol)
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND s.instrument_type = 'EQ'
    AND coalesce(s.series, 'EQ') NOT IN ('SM','ST')
    AND coalesce(s.penny_excluded, false) = false
  ORDER BY (w.symbol IS NULL), s.symbol;
$$;
REVOKE ALL ON FUNCTION public.market_live_sweep_universe() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_live_sweep_universe() TO service_role;

CREATE OR REPLACE FUNCTION public.begin_market_live_sweep(_sweep_id uuid, _session_date date, _as_of timestamptz, _stale_after interval DEFAULT interval '4 minutes')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _expected integer;
  _running uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('market-live-sweep'));
  UPDATE public.market_live_price_runs
     SET status='failed', error_message='stale sweep superseded', completed_at=now()
   WHERE status='running' AND started_at < now() - _stale_after;
  SELECT sweep_id INTO _running FROM public.market_live_price_runs WHERE status='running' LIMIT 1;
  IF _running IS NOT NULL THEN
    RETURN jsonb_build_object('started',false,'reason','overlap','sweep_id',_running);
  END IF;
  SELECT count(*) INTO _expected FROM public.market_live_sweep_universe();
  INSERT INTO public.market_live_price_runs(sweep_id,session_date,as_of,expected_count)
  VALUES (_sweep_id,_session_date,_as_of,_expected);
  RETURN jsonb_build_object('started',true,'expected_count',_expected,'sweep_id',_sweep_id);
END;
$$;
REVOKE ALL ON FUNCTION public.begin_market_live_sweep(uuid,date,timestamptz,interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_market_live_sweep(uuid,date,timestamptz,interval) TO service_role;

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
  SELECT * INTO _run FROM public.market_live_price_runs WHERE sweep_id=_sweep_id FOR UPDATE;
  IF NOT FOUND OR _run.status <> 'running' THEN RETURN jsonb_build_object('promoted',false,'reason','run_not_running'); END IF;

  SELECT count(*) INTO _priced
  FROM public.market_live_price_stage st
  JOIN public.market_live_sweep_universe() u ON u.symbol=st.symbol
  WHERE st.sweep_id=_sweep_id AND st.exchange='NSE' AND st.ltp IS NOT NULL AND st.quote_rejected=false;
  SELECT count(*) INTO _rejected FROM public.market_live_price_stage WHERE sweep_id=_sweep_id AND quote_rejected=true;
  _coverage := _priced::numeric / greatest(_run.expected_count,1);
  IF _coverage >= _min_coverage THEN _mode := 'full';
  ELSIF _coverage >= _partial_floor THEN _mode := 'partial';
  ELSE _mode := 'failed'; END IF;

  IF _mode='failed' THEN
    UPDATE public.market_live_price_runs SET status='failed',priced_count=_priced,failed_count=greatest(expected_count-_priced,0),completed_at=now(),error_message=format('coverage below promotion floor (%s/%s = %s)',_priced,_run.expected_count,round(_coverage,4)) WHERE sweep_id=_sweep_id;
    DELETE FROM public.market_live_price_stage WHERE sweep_id=_sweep_id;
    RETURN jsonb_build_object('promoted',false,'reason','coverage','priced',_priced,'expected',_run.expected_count,'coverage',_coverage,'rejected',_rejected);
  END IF;

  INSERT INTO public.market_live_prices(symbol,exchange,session_date,ltp,prev_close,change_abs,change_pct,volume,provider,sweep_id,as_of,market_cap_live,quote_rejected,reject_reason,updated_at)
  SELECT st.symbol,st.exchange,st.session_date,st.ltp,st.prev_close,st.change_abs,st.change_pct,st.volume,st.provider,st.sweep_id,st.as_of,st.market_cap_live,st.quote_rejected,st.reject_reason,now()
  FROM public.market_live_price_stage st JOIN public.market_live_sweep_universe() u ON u.symbol=st.symbol
  WHERE st.sweep_id=_sweep_id AND st.exchange='NSE' AND st.ltp IS NOT NULL AND st.quote_rejected=false
  ON CONFLICT(symbol,exchange) DO UPDATE SET session_date=excluded.session_date,ltp=excluded.ltp,prev_close=excluded.prev_close,change_abs=excluded.change_abs,change_pct=excluded.change_pct,volume=excluded.volume,provider=excluded.provider,sweep_id=excluded.sweep_id,as_of=excluded.as_of,market_cap_live=excluded.market_cap_live,quote_rejected=excluded.quote_rejected,reject_reason=excluded.reject_reason,updated_at=now();

  IF _mode='full' THEN
    DELETE FROM public.market_live_prices lp
    WHERE lp.exchange='NSE' AND NOT EXISTS (SELECT 1 FROM public.market_live_sweep_universe() u WHERE u.symbol=lp.symbol);
    GET DIAGNOSTICS _removed=ROW_COUNT;
  END IF;
  UPDATE public.market_live_price_runs SET status=CASE WHEN _mode='full' THEN 'complete' ELSE 'partial' END,priced_count=_priced,failed_count=greatest(expected_count-_priced,0),completed_at=now(),error_message=CASE WHEN _mode='full' THEN NULL ELSE format('partial promotion (%s/%s = %s)',_priced,_run.expected_count,round(_coverage,4)) END WHERE sweep_id=_sweep_id;
  DELETE FROM public.market_live_price_stage WHERE sweep_id=_sweep_id;
  RETURN jsonb_build_object('promoted',true,'mode',_mode,'priced',_priced,'expected',_run.expected_count,'coverage',_coverage,'rejected',_rejected,'pruned',_removed);
END;
$$;
REVOKE ALL ON FUNCTION public.promote_market_live_sweep(uuid,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_market_live_sweep(uuid,numeric) TO service_role;

DELETE FROM public.market_sweep_snapshot WHERE session_date = current_date;