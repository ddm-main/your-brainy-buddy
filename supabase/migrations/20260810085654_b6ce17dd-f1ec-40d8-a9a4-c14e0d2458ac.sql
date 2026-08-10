-- Seed the built-in chain as explicit app-wide routing rows.
-- Until now market_feed_prefs was empty, so every route was implied by the
-- hard-coded BASE_CHAIN and the Feed Routing panel showed "auto" everywhere.
DELETE FROM public.market_feed_prefs
 WHERE scope = 'system'
   AND feed_id IN ('ltp','indices','depth','candles_1d','candles_intraday','fundamentals');

INSERT INTO public.market_feed_prefs (scope, user_id, feed_id, provider, fallback_provider)
VALUES
  ('system', NULL, 'ltp',              'kotak',  'shoonya'),
  -- Kotak Neo carries no index instruments — indices are Yahoo-first by design.
  ('system', NULL, 'indices',          'yahoo',  'kotak'),
  ('system', NULL, 'depth',            'kotak',  'shoonya'),
  -- Kotak publishes no candle API; history is Yahoo/NSE served.
  ('system', NULL, 'candles_1d',       'yahoo',  'nse'),
  ('system', NULL, 'candles_intraday', 'yahoo',  NULL),
  -- No broker publishes ratios/ownership — vendor chain only.
  ('system', NULL, 'fundamentals',     'fmp',    'yahoo');