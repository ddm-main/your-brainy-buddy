
-- 1) Retire renamed NSE symbols (they no longer trade under these names)
UPDATE public.market_stocks
   SET is_active = false, updated_at = now()
 WHERE exchange = 'NSE'
   AND symbol IN ('GMRINFRA','TATAMOTORS','ZOMATO','LTIM');

DELETE FROM public.market_fundamentals_global
 WHERE exchange = 'NSE'
   AND symbol IN ('GMRINFRA','TATAMOTORS','ZOMATO','LTIM');

-- 2) Mark passive-fund tickers as ETF instrument type
UPDATE public.market_stocks
   SET instrument_type = 'ETF', updated_at = now()
 WHERE is_active = true
   AND exchange = 'NSE'
   AND COALESCE(instrument_type, 'EQ') <> 'ETF'
   AND (
     symbol ~ '(ETF|BEES|IETF|BANETF|LIQUID|GOLD|SILVER|NIFTY|SENSEX|ALPHA|MOMENT|MOMENTUM|LOWVOL|VALUE|QUAL|MIDCAP|SMALLCAP|MULTICAP|MFG|CONSUM|PHARMA|AUTO|IT|BANK|PSU|CPSE|INFRA|REIT|INVIT|TBILL|GILT|SDL|LIQ)$'
     OR symbol ~ '^(ETF|BEES|GOLD|SILVER|NIFTY|SENSEX|LIQUID|ALPHA|LIQ|BANK|BANKBEES|PSU)'
   );

-- 3) Backfill sector for ETFs in market_fundamentals_global so they drop out of "sector null" gaps
INSERT INTO public.market_fundamentals_global (symbol, exchange, sector, industry, sync_source, sync_status, updated_at, data_as_of)
SELECT s.symbol, s.exchange, 'ETF / Index Fund', 'Passive Fund', 'seed', 'ok', now(), now()
  FROM public.market_stocks s
 WHERE s.is_active = true
   AND s.exchange = 'NSE'
   AND s.instrument_type = 'ETF'
ON CONFLICT (symbol, exchange) DO UPDATE
   SET sector   = COALESCE(EXCLUDED.sector,   public.market_fundamentals_global.sector),
       industry = COALESCE(public.market_fundamentals_global.industry, EXCLUDED.industry),
       updated_at = now();
