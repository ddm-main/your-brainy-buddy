
UPDATE public.market_stocks
SET instrument_type = CASE
  WHEN symbol ~ '(ETF|BEES|IETF|LIQUID|LIQUIDBEES|GOLD|SILVER|NN50ET|N50|BANKBEES|CPSEETF|MOM100|PSUBNK|MID150|SETFNIF50|SETFNN50|JUNIORBEES|MAFANG|MASPTOP50|MON100)$'
    OR (symbol ~ '^(ABSL|AONE|NIPPON|MIRAE|MOTILAL|HDFCMF|ICICI|KOTAK)' AND symbol ~ '(ETF|FUND|GOLD|SILVER|LIQUID|BEES|NIFTY|SENSEX)$')
    OR company_name ILIKE '%ETF%'
    OR company_name ILIKE '%exchange traded fund%'
    OR company_name ILIKE '%index fund%'
    OR company_name ILIKE '%bees%'
    THEN 'ETF'
  WHEN company_name ILIKE '%mutual fund%'
    OR company_name ILIKE '%liquid fund%'
    OR company_name ILIKE '%trust for investment%'
    THEN 'FUND'
  ELSE 'EQ'
END
WHERE is_active = true AND (instrument_type IS NULL OR instrument_type = '');

DROP VIEW IF EXISTS public.market_screener_rows;
CREATE VIEW public.market_screener_rows AS
SELECT s.symbol, s.exchange, s.company_name,
  COALESCE(f.sector, s.sector, sc.sector) AS sector,
  COALESCE(f.industry, s.industry) AS industry,
  COALESCE(f.market_cap_cr, s.market_cap) AS market_cap,
  s.is_nifty500, s.in_universe, s.is_active,
  COALESCE(s.instrument_type, 'EQ') AS instrument_type,
  s.yahoo_symbol, s.last_price_sync_at, s.last_fundamentals_sync_at,
  sc.id AS score_id, sc.trade_date, sc.close, sc.change_pct, sc.volume, sc.vol_avg20, sc.rel_volume,
  sc.ema20, sc.ema50, sc.ema100, sc.ema200, sc.rsi14, sc.macd, sc.macd_signal, sc.macd_hist,
  sc.adx14, sc.atr14, sc.atr_pct, sc.bb_upper, sc.bb_lower, sc.bb_width, sc.bb_squeeze,
  sc.high_52w, sc.low_52w, sc.pct_from_52w_high, sc.above_ema200, sc.higher_lows,
  sc.near_resistance, sc.resistance_level, sc.support_level,
  sc.sector_strength, sc.rel_strength_nifty, sc.breakout_score, sc.prebreakout_score,
  sc.score_components, sc.computed_at,
  f.price AS fundamental_price, f.pe_ttm, f.pb, f.peg, f.eps_ttm, f.book_value,
  f.dividend_yield, f.roe, f.roce, f.debt_to_equity, f.current_ratio, f.quick_ratio,
  f.revenue_ttm_cr, f.profit_ttm_cr, f.revenue_growth_yoy, f.profit_growth_yoy, f.eps_growth_yoy,
  f.promoter_holding, f.promoter_pledge, f.fii_holding, f.dii_holding, f.face_value,
  f.high_52w AS fundamental_high_52w, f.low_52w AS fundamental_low_52w,
  f.sync_source, f.sync_status, f.last_error, f.data_as_of, f.last_attempted_at,
  f.updated_at AS fundamentals_updated_at
FROM public.market_stocks s
LEFT JOIN public.market_stock_scores sc ON sc.symbol = s.symbol AND sc.exchange = s.exchange
LEFT JOIN public.market_fundamentals_global f ON f.symbol = s.symbol AND f.exchange = s.exchange
WHERE s.is_active = true;
GRANT SELECT ON public.market_screener_rows TO anon, authenticated, service_role;

DROP VIEW IF EXISTS public.market_pipeline_status;
CREATE VIEW public.market_pipeline_status AS
SELECT
  (SELECT count(*) FROM public.market_stocks WHERE is_active) AS active_stocks,
  (SELECT count(*) FROM public.market_stocks WHERE is_active AND COALESCE(instrument_type,'EQ')='EQ') AS equities_total,
  (SELECT count(*) FROM public.market_fundamentals_global f
     JOIN public.market_stocks s USING (symbol, exchange)
    WHERE s.is_active AND COALESCE(s.instrument_type,'EQ')='EQ'
      AND f.sync_status IN ('ok','partial')) AS equities_covered,
  (SELECT count(*) FROM public.market_fundamentals_global f
     JOIN public.market_stocks s USING (symbol, exchange)
    WHERE s.is_active AND COALESCE(s.instrument_type,'EQ')='EQ'
      AND f.sector IS NOT NULL) AS equities_with_sector,
  (SELECT count(*) FROM public.market_fundamentals_global WHERE sync_status IN ('ok','partial')) AS fundamentals_covered,
  (SELECT count(*) FROM public.market_fundamentals_global WHERE sync_status = 'failed') AS fundamentals_failed,
  (SELECT max(updated_at) FROM public.market_fundamentals_global) AS fundamentals_last_updated_at,
  (SELECT max(trade_date) FROM public.market_stock_scores) AS scores_last_trade_date,
  (SELECT count(*) FROM public.market_stock_scores
    WHERE trade_date = (SELECT max(trade_date) FROM public.market_stock_scores)) AS scores_last_count;
GRANT SELECT ON public.market_pipeline_status TO anon, authenticated, service_role;

UPDATE public.market_stocks s
SET last_fundamentals_sync_at = NULL
FROM public.market_fundamentals_global f
WHERE f.symbol = s.symbol AND f.exchange = s.exchange
  AND f.sync_status IN ('partial','failed')
  AND s.is_active;

UPDATE public.market_stocks s
SET last_price_sync_at = NULL
WHERE s.is_active
  AND NOT EXISTS (
    SELECT 1 FROM public.market_stock_scores sc
    WHERE sc.symbol = s.symbol AND sc.exchange = s.exchange
  );
