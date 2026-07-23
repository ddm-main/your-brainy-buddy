
-- 1) Retire renamed NSE symbols (idempotent)
UPDATE public.market_stocks
   SET is_active = false
 WHERE exchange = 'NSE'
   AND symbol IN ('GMRINFRA','TATAMOTORS','ZOMATO','LTIM')
   AND is_active = true;

-- 2a) Backfill ETF/Fund labels on market_fundamentals_global
UPDATE public.market_fundamentals_global f
   SET sector   = COALESCE(f.sector,   'ETF / Index Fund'),
       industry = COALESCE(f.industry, 'Passive Fund'),
       updated_at = now()
  FROM public.market_stocks s
 WHERE s.symbol = f.symbol
   AND s.exchange = f.exchange
   AND s.is_active = true
   AND COALESCE(s.instrument_type, 'EQ') IN ('ETF','FUND')
   AND (f.sector IS NULL OR f.industry IS NULL);

-- 2b) Mirror onto market_stocks so the base table is self-sufficient
UPDATE public.market_stocks s
   SET sector   = COALESCE(s.sector,   'ETF / Index Fund'),
       industry = COALESCE(s.industry, 'Passive Fund')
 WHERE s.is_active = true
   AND COALESCE(s.instrument_type, 'EQ') IN ('ETF','FUND')
   AND (s.sector IS NULL OR s.industry IS NULL);

-- 3) Promote qualifying `partial` rows → `ok`
UPDATE public.market_fundamentals_global
   SET sync_status = 'ok',
       last_error  = NULL,
       updated_at  = now()
 WHERE sync_status = 'partial'
   AND sector IS NOT NULL
   AND market_cap_cr IS NOT NULL
   AND (pe_ttm IS NOT NULL OR eps_ttm IS NOT NULL)
   AND price IS NOT NULL;
