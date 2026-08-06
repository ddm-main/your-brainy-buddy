-- 1) Promotion must clear symbols that were not priced by the promoted sweep,
--    so no row can survive carrying an older sweep's price.
CREATE OR REPLACE FUNCTION public.promote_market_live_sweep(_sweep_id uuid, _min_coverage numeric DEFAULT 0.98)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _run public.market_live_price_runs%ROWTYPE;
  _priced integer;
  _coverage numeric;
  _removed integer;
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

  -- Any row not republished by this sweep is not live any more.
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
                            'coverage', _coverage, 'evicted', _removed);
END;
$fn$;

-- 2) Screener view: session-gated live plane + live-derived technicals/fundamentals.
DROP VIEW IF EXISTS public.market_screener_rows;
CREATE VIEW public.market_screener_rows AS
WITH sess AS (
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS ist_date,
         LEAST(1.0, GREATEST(0.02,
           EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'Asia/Kolkata')
                               - date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
                               - interval '9 hours 15 minutes')) / 22500.0
         ))::numeric AS elapsed_frac
)
SELECT s.symbol,
    s.exchange,
    s.company_name,
    s.sector,
    s.sub_sector,
    s.industry,
    s.market_cap_reported,
    s.is_nifty500,
    s.in_universe,
    s.is_active,
    s.instrument_type,
    s.yahoo_symbol,
    s.last_price_sync_at,
    s.last_fundamentals_sync_at,
    s.fno_enabled,
    s.sme,
    s.score_id,
    s.close_adjusted,
    s.vol_avg20,
    s.vol_avg30,
    s.rel_volume,
    s.ema20,
    s.ema50,
    s.ema100,
    s.ema200,
    s.rsi14,
    s.macd,
    s.macd_signal,
    s.macd_hist,
    s.adx14,
    s.atr14,
    s.atr_pct,
    s.bb_upper,
    s.bb_lower,
    s.bb_width,
    s.bb_squeeze,
    s.high_52w,
    s.low_52w,
    s.pct_from_52w_high,
    s.above_ema200,
    s.higher_lows,
    s.near_resistance,
    s.resistance_level,
    s.support_level,
    s.sector_strength,
    s.rel_strength_nifty,
    s.breakout_score,
    s.prebreakout_score,
    s.score_components,
    s.computed_at,
    s.ret_5d,
    s.ret_21d,
    s.ret_ytd,
    s.fundamental_price,
    s.pe_ttm,
    s.pb,
    s.peg,
    s.eps_ttm,
    s.book_value,
    s.dividend_yield,
    s.roe,
    s.roce,
    s.debt_to_equity,
    s.current_ratio,
    s.quick_ratio,
    s.revenue_ttm_cr,
    s.profit_ttm_cr,
    s.revenue_growth_yoy,
    s.profit_growth_yoy,
    s.eps_growth_yoy,
    s.promoter_holding,
    s.promoter_pledge,
    s.fii_holding,
    s.dii_holding,
    s.face_value,
    s.fundamental_high_52w,
    s.fundamental_low_52w,
    s.sync_source,
    s.sync_status,
    s.last_error,
    s.data_as_of,
    s.last_attempted_at,
    s.fundamentals_updated_at,
    s.data_provenance,
    s.strict_ok,
    s.score_trade_date,
    s.is_liquid_tradable,
    s.liquidity_reasons,
    s.swing_score,
    s.intraday_score,
    s.refreshed_at,
    COALESCE(l.session_date, s.trade_date) AS trade_date,
    COALESCE(l.ltp, s.close) AS close,
    COALESCE(l.change_abs, s.change_abs) AS change_abs,
    COALESCE(round(l.change_pct, 2), s.change_pct) AS change_pct,
    COALESCE(l.change_pct, s.change_pct_raw) AS change_pct_raw,
    COALESCE(l.volume, s.volume) AS volume,
    COALESCE(l.prev_close, s.previous_close) AS previous_close,
    COALESCE(l.volume, s.volume) IS NOT NULL AND s.vol_avg30 IS NOT NULL AND s.vol_avg30 > 0::numeric
      AND COALESCE(l.volume, s.volume)::numeric > s.vol_avg30 AS vol_gt_avg30,
    CASE
        WHEN s.market_cap_reported IS NOT NULL AND s.market_cap_reported > 0::numeric AND s.fundamental_price IS NOT NULL AND s.fundamental_price > 0::numeric AND COALESCE(l.ltp, s.close) IS NOT NULL AND COALESCE(l.ltp, s.close) > 0::numeric THEN round(s.market_cap_reported * (COALESCE(l.ltp, s.close) / s.fundamental_price), 2)
        WHEN s.market_cap_reported IS NOT NULL AND s.market_cap_reported > 0::numeric THEN round(s.market_cap_reported, 2)
        WHEN l.ltp IS NOT NULL AND s.close IS NOT NULL AND s.close > 0::numeric AND s.market_cap IS NOT NULL THEN round(s.market_cap * (l.ltp / s.close), 2)
        ELSE s.market_cap
    END AS market_cap,
    l.provider AS live_provider,
    l.as_of AS live_as_of,
    l.sweep_id AS live_sweep_id,
    l.session_date AS live_session_date,
    l.volume AS live_volume,
    CASE
        WHEN l.ltp IS NOT NULL THEN 'live'::text
        WHEN lp.ltp IS NOT NULL AND s.close IS NOT NULL THEN 'stale_live'::text
        WHEN s.close IS NOT NULL THEN 'eod'::text
        ELSE 'no_quote'::text
    END AS quote_state,
    s.trade_date AS eod_trade_date,
    s.close AS eod_close,
    s.previous_close AS eod_previous_close,
    s.change_abs AS eod_change_abs,
    s.change_pct AS eod_change_pct,
    s.change_pct_raw AS eod_change_pct_raw,
    s.volume AS eod_volume,
    s.market_cap AS eod_market_cap,
    s.volume IS NOT NULL AND s.vol_avg30 IS NOT NULL AND s.vol_avg30 > 0::numeric AND s.volume::numeric > s.vol_avg30 AS eod_vol_gt_avg30,
    CASE
        WHEN s.market_cap_reported IS NOT NULL AND s.market_cap_reported > 0::numeric AND s.fundamental_price IS NOT NULL AND s.fundamental_price > 0::numeric AND COALESCE(l.ltp, s.close) IS NOT NULL AND COALESCE(l.ltp, s.close) > 0::numeric THEN
        CASE
            WHEN l.ltp IS NOT NULL THEN 'reported_live'::text
            ELSE 'reported_eod'::text
        END
        WHEN s.market_cap_reported IS NOT NULL AND s.market_cap_reported > 0::numeric THEN 'reported'::text
        WHEN s.market_cap IS NOT NULL THEN 'derived'::text
        ELSE 'none'::text
    END AS mcap_basis,
    -- ---- freshness ----
    CASE WHEN l.as_of IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - l.as_of)))::integer END AS live_age_s,
    (lp.ltp IS NOT NULL AND l.ltp IS NULL) AS live_stale,
    lp.session_date AS stale_live_session_date,
    x.elapsed_frac AS session_elapsed_frac,
    -- ---- volume pacing ----
    CASE WHEN l.volume IS NOT NULL AND s.vol_avg30 IS NOT NULL AND s.vol_avg30 > 0
         THEN round((l.volume::numeric / (s.vol_avg30 * x.elapsed_frac)), 3) END AS vol_pace_ratio,
    CASE WHEN l.volume IS NOT NULL AND s.vol_avg30 IS NOT NULL AND s.vol_avg30 > 0
         THEN l.volume::numeric > (s.vol_avg30 * x.elapsed_frac) END AS vol_gt_avg30_paced,
    CASE WHEN l.volume IS NOT NULL AND s.vol_avg30 IS NOT NULL AND s.vol_avg30 > 0
         THEN round((l.volume::numeric / s.vol_avg30), 3) ELSE s.rel_volume END AS rel_volume_live,
    -- ---- price-derived fundamentals, revalued at the live price ----
    CASE WHEN l.ltp IS NOT NULL AND s.fundamental_price > 0 THEN round(l.ltp / s.fundamental_price, 6) END AS price_basis_ratio,
    CASE WHEN l.ltp IS NOT NULL AND s.fundamental_price > 0 AND s.pe_ttm IS NOT NULL
         THEN round(s.pe_ttm * (l.ltp / s.fundamental_price), 2) ELSE s.pe_ttm END AS pe_live,
    CASE WHEN l.ltp IS NOT NULL AND s.fundamental_price > 0 AND s.pb IS NOT NULL
         THEN round(s.pb * (l.ltp / s.fundamental_price), 3) ELSE s.pb END AS pb_live,
    CASE WHEN l.ltp IS NOT NULL AND s.fundamental_price > 0 AND s.peg IS NOT NULL
         THEN round(s.peg * (l.ltp / s.fundamental_price), 3) ELSE s.peg END AS peg_live,
    CASE WHEN l.ltp IS NOT NULL AND l.ltp > 0 AND s.fundamental_price > 0 AND s.dividend_yield IS NOT NULL
         THEN round(s.dividend_yield * (s.fundamental_price / l.ltp), 3) ELSE s.dividend_yield END AS dividend_yield_live,
    CASE WHEN COALESCE(l.ltp, s.close) > 0 AND s.eps_ttm IS NOT NULL
         THEN round((s.eps_ttm / COALESCE(l.ltp, s.close)) * 100, 3) END AS earnings_yield_live,
    -- ---- price-derived technicals, recomputed at the live price ----
    CASE WHEN l.ltp IS NOT NULL AND s.high_52w IS NOT NULL THEN GREATEST(s.high_52w, l.ltp) ELSE s.high_52w END AS high_52w_live,
    CASE WHEN l.ltp IS NOT NULL AND s.low_52w IS NOT NULL THEN LEAST(s.low_52w, l.ltp) ELSE s.low_52w END AS low_52w_live,
    CASE WHEN l.ltp IS NOT NULL AND s.high_52w IS NOT NULL AND s.high_52w > 0
         THEN round(((l.ltp - GREATEST(s.high_52w, l.ltp)) / GREATEST(s.high_52w, l.ltp)) * 100, 2)
         ELSE s.pct_from_52w_high END AS pct_from_52w_high_live,
    CASE WHEN l.ltp IS NOT NULL AND s.ema200 IS NOT NULL THEN l.ltp > s.ema200 ELSE s.above_ema200 END AS above_ema200_live,
    CASE WHEN l.ltp IS NOT NULL AND s.resistance_level IS NOT NULL AND s.resistance_level > 0
         THEN l.ltp >= s.resistance_level * 0.98 ELSE s.near_resistance END AS near_resistance_live,
    CASE WHEN l.ltp IS NOT NULL AND l.ltp > 0 AND s.atr14 IS NOT NULL
         THEN round((s.atr14 / l.ltp) * 100, 3) ELSE s.atr_pct END AS atr_pct_live
   FROM market_screener_snapshot s
     CROSS JOIN sess x
     LEFT JOIN market_live_prices lp ON lp.symbol = s.symbol AND lp.exchange = s.exchange AND lp.ltp IS NOT NULL
     LEFT JOIN LATERAL (
       SELECT lp.session_date, lp.ltp, lp.prev_close, lp.change_abs, lp.change_pct,
              lp.volume, lp.provider, lp.sweep_id, lp.as_of
       WHERE lp.session_date >= x.ist_date
     ) l ON true;

GRANT SELECT ON public.market_screener_rows TO authenticated;
GRANT SELECT ON public.market_screener_rows TO service_role;