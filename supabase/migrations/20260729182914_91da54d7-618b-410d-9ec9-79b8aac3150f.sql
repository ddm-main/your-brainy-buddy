-- 1) Negative cache for scrip-master token gaps.
ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS token_missing_at timestamptz;

COMMENT ON COLUMN public.market_stocks.token_missing_at IS
  'Set by market-scrips-sync when a full Kotak scrip-master pass found no instrument token for this symbol. Providers skip the broker round-trip (and the health-row spam) while this is recent; cleared as soon as a token appears.';

CREATE INDEX IF NOT EXISTS market_stocks_token_missing_idx
  ON public.market_stocks (exchange, token_missing_at)
  WHERE token IS NULL;

UPDATE public.market_stocks
   SET token_missing_at = now()
 WHERE token IS NULL AND is_active AND token_missing_at IS NULL;

-- 2) NV20: drop the corrupted bar. Every other bar in the series is ~13-14;
-- 2026-07-28 carries 11807.6, an index-scale value written onto the ETF row.
DELETE FROM public.market_daily_prices
 WHERE symbol = 'NV20' AND exchange = 'NSE' AND trade_date = DATE '2026-07-28'
   AND close > 1000;

DELETE FROM public.market_stock_scores
 WHERE symbol = 'NV20' AND exchange = 'NSE' AND close > 1000;

-- 3) Legacy column: the Kotak Neo v2 TOTP flow uses view/session tokens only.
COMMENT ON COLUMN public.market_api_settings.access_token_enc IS
  'LEGACY / UNUSED. Left over from the pre-v2 Kotak OAuth flow. The current TOTP flow (kotakClient.kotakLogin) persists view_token_enc + session_token_enc + sid only; no code reads this column. Always null - not a misconfiguration.';
