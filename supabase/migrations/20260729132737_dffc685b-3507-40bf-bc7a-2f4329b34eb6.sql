
-- Purge bogus surface probe rows so the health tally reflects reality.
DELETE FROM public.market_surface_probes
WHERE provider = 'unavailable'
   OR (provider IN ('yahoo','yahoo_finance') AND surface IN ('holdings','funds','positions','depth'))
   OR (provider IN ('kotak','kotak_neo') AND surface IN ('candles_1d','candles_intraday','candles_index_1d'));
