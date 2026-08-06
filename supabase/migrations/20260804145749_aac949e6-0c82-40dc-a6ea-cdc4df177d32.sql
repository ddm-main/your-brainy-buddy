CREATE OR REPLACE VIEW public.market_screener_rows AS
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
    ((COALESCE(l.volume, s.volume) IS NOT NULL) AND (s.vol_avg30 IS NOT NULL) AND (s.vol_avg30 > (0)::numeric) AND ((COALESCE(l.volume, s.volume))::numeric > s.vol_avg30)) AS vol_gt_avg30,
    -- Market cap: shares implied by the reported cap and the price it was
    -- reported against, revalued at the effective (live or settled) price.
    -- The old expression scaled the score-table cap, which is wrong whenever
    -- that cap is stale (YASHO showed 277 Cr instead of ~5,250 Cr).
    CASE
        WHEN (s.market_cap_reported IS NOT NULL AND s.market_cap_reported > 0
              AND s.fundamental_price IS NOT NULL AND s.fundamental_price > 0
              AND COALESCE(l.ltp, s.close) IS NOT NULL AND COALESCE(l.ltp, s.close) > 0)
            THEN round(s.market_cap_reported * (COALESCE(l.ltp, s.close) / s.fundamental_price), 2)
        WHEN (s.market_cap_reported IS NOT NULL AND s.market_cap_reported > 0)
            THEN round(s.market_cap_reported, 2)
        WHEN ((l.ltp IS NOT NULL) AND (s.close IS NOT NULL) AND (s.close > (0)::numeric) AND (s.market_cap IS NOT NULL))
            THEN round((s.market_cap * (l.ltp / s.close)), 2)
        ELSE s.market_cap
    END AS market_cap,
    l.provider AS live_provider,
    l.as_of AS live_as_of,
    l.sweep_id AS live_sweep_id,
    l.session_date AS live_session_date,
    l.volume AS live_volume,
    CASE
        WHEN (l.ltp IS NOT NULL) THEN 'live'::text
        WHEN (s.close IS NOT NULL) THEN 'eod'::text
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
    ((s.volume IS NOT NULL) AND (s.vol_avg30 IS NOT NULL) AND (s.vol_avg30 > (0)::numeric) AND ((s.volume)::numeric > s.vol_avg30)) AS eod_vol_gt_avg30,
    CASE
        WHEN (s.market_cap_reported IS NOT NULL AND s.market_cap_reported > 0
              AND s.fundamental_price IS NOT NULL AND s.fundamental_price > 0
              AND COALESCE(l.ltp, s.close) IS NOT NULL AND COALESCE(l.ltp, s.close) > 0)
            THEN CASE WHEN l.ltp IS NOT NULL THEN 'reported_live'::text ELSE 'reported_eod'::text END
        WHEN (s.market_cap_reported IS NOT NULL AND s.market_cap_reported > 0) THEN 'reported'::text
        WHEN (s.market_cap IS NOT NULL) THEN 'derived'::text
        ELSE 'none'::text
    END AS mcap_basis
   FROM (public.market_screener_snapshot s
     LEFT JOIN public.market_live_prices l ON (((l.symbol = s.symbol) AND (l.exchange = s.exchange) AND (l.ltp IS NOT NULL))));

GRANT SELECT ON public.market_screener_rows TO authenticated;
GRANT SELECT ON public.market_screener_rows TO anon;
GRANT SELECT ON public.market_screener_rows TO service_role;