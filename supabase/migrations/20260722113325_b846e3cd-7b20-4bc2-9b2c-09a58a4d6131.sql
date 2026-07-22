
DROP VIEW IF EXISTS public.market_screener_rows;
CREATE VIEW public.market_screener_rows AS
WITH latest_shares AS (
  SELECT DISTINCT ON (symbol)
    symbol, total_shares, as_of, source AS shares_source
  FROM public.market_shares_outstanding
  ORDER BY symbol, as_of DESC
)
SELECT s.symbol,
       s.exchange,
       s.company_name,
       COALESCE(f.sector, s.sector, sc.sector)     AS sector,
       COALESCE(f.industry, s.industry)             AS industry,
       -- Reported (FMP/Yahoo) mcap: quarter-lagged, kept for audit
       COALESCE(f.market_cap_cr, s.market_cap)      AS market_cap_reported,
       -- Authoritative mcap ladder:
       --   1. shares_out × NSE close   → matches Tickertape
       --   2. shares_out × scores close → still authoritative shares_out
       --   3. reported mcap re-priced to today's close (previous logic)
       --   4. reported mcap (last resort)
       CASE
         WHEN ls.total_shares IS NOT NULL AND en.close IS NOT NULL AND en.close > 0
           THEN ROUND((ls.total_shares * en.close / 1e7)::numeric, 2)
         WHEN ls.total_shares IS NOT NULL AND sc.close IS NOT NULL AND sc.close > 0
           THEN ROUND((ls.total_shares * sc.close / 1e7)::numeric, 2)
         WHEN f.market_cap_cr IS NOT NULL AND f.price IS NOT NULL AND f.price > 0 AND sc.close IS NOT NULL AND sc.close > 0
           THEN ROUND((f.market_cap_cr * (sc.close / f.price))::numeric, 2)
         ELSE COALESCE(f.market_cap_cr, s.market_cap)
       END                                          AS market_cap,
       s.is_nifty500,
       s.in_universe,
       s.is_active,
       COALESCE(s.instrument_type, 'EQ'::text)      AS instrument_type,
       s.yahoo_symbol,
       s.last_price_sync_at,
       s.last_fundamentals_sync_at,
       EXISTS (
         SELECT 1 FROM public.market_stocks x
         WHERE x.symbol = s.symbol
           AND x.is_active = true
           AND x.instrument_type IN ('FUT','OPT','FUTIDX','OPTIDX','FUTSTK','OPTSTK')
       ) AS fno_enabled,
       COALESCE(s.series IN ('BE','BZ','SM','ST','SME'), false) AS sme,
       sc.id AS score_id,
       -- Prefer NSE trade_date when present (it's the settled EOD date).
       COALESCE(en.trade_date, sc.trade_date)       AS trade_date,
       -- Authoritative close/volume/prev_close from NSE bhavcopy when available.
       COALESCE(en.close, sc.close)                 AS close,
       CASE
         WHEN en.close IS NOT NULL AND en.prev_close IS NOT NULL AND en.prev_close > 0
           THEN ROUND(((en.close - en.prev_close) / en.prev_close * 100)::numeric, 2)
         ELSE sc.change_pct
       END                                          AS change_pct,
       COALESCE(en.volume, sc.volume)               AS volume,
       en.prev_close                                AS previous_close,
       sc.vol_avg20,
       sc.rel_volume,
       sc.ema20, sc.ema50, sc.ema100, sc.ema200,
       sc.rsi14, sc.macd, sc.macd_signal, sc.macd_hist,
       sc.adx14, sc.atr14, sc.atr_pct,
       sc.bb_upper, sc.bb_lower, sc.bb_width, sc.bb_squeeze,
       sc.high_52w, sc.low_52w, sc.pct_from_52w_high,
       sc.above_ema200, sc.higher_lows, sc.near_resistance,
       sc.resistance_level, sc.support_level,
       sc.sector_strength, sc.rel_strength_nifty,
       sc.breakout_score, sc.prebreakout_score, sc.score_components,
       sc.computed_at,
       sc.ret_5d, sc.ret_21d, sc.ret_ytd,
       f.price AS fundamental_price,
       f.pe_ttm, f.pb, f.peg, f.eps_ttm, f.book_value, f.dividend_yield,
       f.roe, f.roce, f.debt_to_equity, f.current_ratio, f.quick_ratio,
       f.revenue_ttm_cr, f.profit_ttm_cr,
       f.revenue_growth_yoy, f.profit_growth_yoy, f.eps_growth_yoy,
       f.promoter_holding, f.promoter_pledge, f.fii_holding, f.dii_holding,
       f.face_value,
       f.high_52w AS fundamental_high_52w,
       f.low_52w  AS fundamental_low_52w,
       f.sync_source, f.sync_status, f.last_error,
       f.data_as_of, f.last_attempted_at,
       f.updated_at AS fundamentals_updated_at,
       -- Provenance: which source did each critical field actually come from?
       jsonb_build_object(
         'close',   CASE WHEN en.close IS NOT NULL THEN 'nse_bhavcopy' ELSE 'stock_scores' END,
         'volume',  CASE WHEN en.volume IS NOT NULL THEN 'nse_bhavcopy' ELSE 'stock_scores' END,
         'mcap',    CASE
                      WHEN ls.total_shares IS NOT NULL AND en.close IS NOT NULL THEN 'shares_x_nse_close'
                      WHEN ls.total_shares IS NOT NULL THEN 'shares_x_scores_close'
                      WHEN f.market_cap_cr IS NOT NULL AND sc.close IS NOT NULL THEN 'fmp_repriced'
                      ELSE 'fmp_raw'
                    END,
         'shares_source', ls.shares_source,
         'shares_as_of',  ls.as_of,
         'nse_trade_date', en.trade_date
       ) AS data_provenance,
       -- Strict: authoritative on close AND volume AND mcap (i.e. all
       -- came from NSE bhavcopy + fresh shares_out ≤ 3 days).
       (en.close IS NOT NULL AND en.volume IS NOT NULL
        AND ls.total_shares IS NOT NULL
        AND ls.as_of >= (CURRENT_DATE - INTERVAL '3 days')) AS strict_ok
  FROM public.market_stocks s
  LEFT JOIN public.market_stock_scores sc
    ON sc.symbol = s.symbol AND sc.exchange = s.exchange
  LEFT JOIN public.market_fundamentals_global f
    ON f.symbol = s.symbol AND f.exchange = s.exchange
  LEFT JOIN LATERAL (
    SELECT close, volume, prev_close, trade_date
    FROM public.market_eod_nse e
    WHERE e.symbol = s.symbol
    ORDER BY e.trade_date DESC
    LIMIT 1
  ) en ON true
  LEFT JOIN latest_shares ls ON ls.symbol = s.symbol
 WHERE s.is_active = true;

ALTER VIEW public.market_screener_rows SET (security_invoker = on);
GRANT SELECT ON public.market_screener_rows TO authenticated;
GRANT SELECT ON public.market_screener_rows TO anon;
GRANT ALL    ON public.market_screener_rows TO service_role;
