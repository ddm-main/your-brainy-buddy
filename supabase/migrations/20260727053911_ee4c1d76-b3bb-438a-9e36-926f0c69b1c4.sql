-- Seed canonical Kotak Neo index tokens (segment: nse_indices).
-- Symbols match the Yahoo-style keys used across src/lib/market/indices.ts.
INSERT INTO public.market_stocks (symbol, exchange, token, kotak_segment, instrument_type, company_name, is_active)
VALUES
  ('^NSEI',    'NSE', '26000', 'nse_indices', 'INDEX', 'Nifty 50',   true),
  ('^NSEBANK', 'NSE', '26009', 'nse_indices', 'INDEX', 'Bank Nifty', true)
ON CONFLICT (symbol, exchange) DO UPDATE
SET token = EXCLUDED.token,
    kotak_segment = EXCLUDED.kotak_segment,
    instrument_type = EXCLUDED.instrument_type,
    updated_at = now();