ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS kotak_segment TEXT;

-- Backfill: existing rows are equities on cash segments.
UPDATE public.market_stocks
   SET kotak_segment = CASE exchange
     WHEN 'BSE' THEN 'bse_cm'
     ELSE 'nse_cm'
   END
 WHERE kotak_segment IS NULL;

COMMENT ON COLUMN public.market_stocks.kotak_segment IS
  'Kotak Neo instrument segment (e.g. nse_cm, bse_cm, nse_indices). Determines which segment quotes/candles are requested against.';