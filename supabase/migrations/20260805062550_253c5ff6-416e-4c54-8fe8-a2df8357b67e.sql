UPDATE public.market_stocks s
   SET is_active = true,
       instrument_type = COALESCE(s.instrument_type, 'EQ'),
       series = COALESCE(s.series, 'EQ'),
       updated_at = now()
 WHERE s.is_active = false
   AND s.exchange = 'NSE'
   AND EXISTS (
     SELECT 1 FROM public.market_eod_nse e
      WHERE e.symbol = s.symbol
        AND e.series = 'EQ'
        AND e.trade_date >= current_date - 7
   );