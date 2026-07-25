
UPDATE public.market_stocks
SET is_active = false
WHERE symbol IN ('GMRINFRA','TATAMOTORS','ZOMATO','LTIM') AND exchange = 'NSE';

UPDATE public.market_fundamentals_global f
SET sector = 'ETF / Index Fund',
    industry = COALESCE(f.industry, 'Passive Fund')
FROM public.market_stocks s
WHERE f.symbol = s.symbol AND f.exchange = s.exchange
  AND s.is_active
  AND s.instrument_type IN ('ETF','FUND')
  AND (f.sector IS NULL OR f.sector = '');

UPDATE public.market_stocks
SET sector = 'ETF / Index Fund'
WHERE is_active
  AND instrument_type IN ('ETF','FUND')
  AND (sector IS NULL OR sector = '');

UPDATE public.market_fundamentals_global
SET sync_status = 'ok', last_error = NULL
WHERE sync_status = 'partial'
  AND sector IS NOT NULL
  AND market_cap_cr IS NOT NULL
  AND (pe_ttm IS NOT NULL OR eps_ttm IS NOT NULL)
  AND price IS NOT NULL;

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
  (SELECT count(*) FROM public.market_stocks s
    WHERE s.is_active AND COALESCE(s.instrument_type,'EQ')='EQ'
      AND s.market_cap IS NOT NULL
      AND s.market_cap_source LIKE 'calc:%shares%') AS mcap_nse_covered,
  (SELECT count(*) FROM public.market_stocks s
    WHERE s.is_active AND COALESCE(s.instrument_type,'EQ')='EQ'
      AND s.market_cap IS NOT NULL) AS mcap_any_covered,
  (SELECT count(*) FROM public.market_fundamentals_global WHERE sync_status IN ('ok','partial')) AS fundamentals_covered,
  (SELECT count(*) FROM public.market_fundamentals_global WHERE sync_status = 'failed') AS fundamentals_failed,
  (SELECT max(updated_at) FROM public.market_fundamentals_global) AS fundamentals_last_updated_at,
  (SELECT max(trade_date) FROM public.market_stock_scores) AS scores_last_trade_date,
  (SELECT count(*) FROM public.market_stock_scores
    WHERE trade_date = (SELECT max(trade_date) FROM public.market_stock_scores)) AS scores_last_count;
GRANT SELECT ON public.market_pipeline_status TO anon, authenticated, service_role;
