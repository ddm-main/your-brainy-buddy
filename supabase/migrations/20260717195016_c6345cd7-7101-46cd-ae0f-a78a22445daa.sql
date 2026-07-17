
CREATE TABLE IF NOT EXISTS public.market_index_members (
  index_key text NOT NULL,
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  weight numeric,
  rank integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_key, symbol)
);

GRANT SELECT ON public.market_index_members TO authenticated;
GRANT ALL ON public.market_index_members TO service_role;

ALTER TABLE public.market_index_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated can read index members" ON public.market_index_members;
CREATE POLICY "authenticated can read index members"
  ON public.market_index_members FOR SELECT
  TO authenticated USING (true);

INSERT INTO public.market_index_members (index_key, symbol, exchange) VALUES
  ('NIFTY50','RELIANCE','NSE'),('NIFTY50','HDFCBANK','NSE'),('NIFTY50','ICICIBANK','NSE'),
  ('NIFTY50','INFY','NSE'),('NIFTY50','TCS','NSE'),('NIFTY50','BHARTIARTL','NSE'),
  ('NIFTY50','ITC','NSE'),('NIFTY50','SBIN','NSE'),('NIFTY50','LT','NSE'),
  ('NIFTY50','HINDUNILVR','NSE'),('NIFTY50','KOTAKBANK','NSE'),('NIFTY50','AXISBANK','NSE'),
  ('NIFTY50','BAJFINANCE','NSE'),('NIFTY50','M&M','NSE'),('NIFTY50','MARUTI','NSE'),
  ('NIFTY50','SUNPHARMA','NSE'),('NIFTY50','NTPC','NSE'),('NIFTY50','HCLTECH','NSE'),
  ('NIFTY50','ASIANPAINT','NSE'),('NIFTY50','TITAN','NSE'),('NIFTY50','ULTRACEMCO','NSE'),
  ('NIFTY50','ONGC','NSE'),('NIFTY50','POWERGRID','NSE'),('NIFTY50','WIPRO','NSE'),
  ('NIFTY50','ADANIENT','NSE'),('NIFTY50','ADANIPORTS','NSE'),('NIFTY50','COALINDIA','NSE'),
  ('NIFTY50','JSWSTEEL','NSE'),('NIFTY50','TATASTEEL','NSE'),('NIFTY50','TATAMOTORS','NSE'),
  ('NIFTY50','BAJAJFINSV','NSE'),('NIFTY50','NESTLEIND','NSE'),('NIFTY50','GRASIM','NSE'),
  ('NIFTY50','TECHM','NSE'),('NIFTY50','HDFCLIFE','NSE'),('NIFTY50','SBILIFE','NSE'),
  ('NIFTY50','DRREDDY','NSE'),('NIFTY50','CIPLA','NSE'),('NIFTY50','DIVISLAB','NSE'),
  ('NIFTY50','APOLLOHOSP','NSE'),('NIFTY50','BRITANNIA','NSE'),('NIFTY50','EICHERMOT','NSE'),
  ('NIFTY50','BAJAJ-AUTO','NSE'),('NIFTY50','HEROMOTOCO','NSE'),('NIFTY50','TATACONSUM','NSE'),
  ('NIFTY50','INDUSINDBK','NSE'),('NIFTY50','BPCL','NSE'),('NIFTY50','HINDALCO','NSE'),
  ('NIFTY50','SHRIRAMFIN','NSE'),('NIFTY50','LTIM','NSE')
ON CONFLICT (index_key, symbol) DO NOTHING;

INSERT INTO public.market_index_members (index_key, symbol, exchange) VALUES
  ('BANKNIFTY','HDFCBANK','NSE'),('BANKNIFTY','ICICIBANK','NSE'),('BANKNIFTY','SBIN','NSE'),
  ('BANKNIFTY','KOTAKBANK','NSE'),('BANKNIFTY','AXISBANK','NSE'),('BANKNIFTY','INDUSINDBK','NSE'),
  ('BANKNIFTY','BANKBARODA','NSE'),('BANKNIFTY','PNB','NSE'),('BANKNIFTY','FEDERALBNK','NSE'),
  ('BANKNIFTY','IDFCFIRSTB','NSE'),('BANKNIFTY','AUBANK','NSE'),('BANKNIFTY','BANDHANBNK','NSE')
ON CONFLICT (index_key, symbol) DO NOTHING;

INSERT INTO public.market_index_members (index_key, symbol, exchange) VALUES
  ('FINNIFTY','HDFCBANK','NSE'),('FINNIFTY','ICICIBANK','NSE'),('FINNIFTY','SBIN','NSE'),
  ('FINNIFTY','KOTAKBANK','NSE'),('FINNIFTY','AXISBANK','NSE'),('FINNIFTY','BAJFINANCE','NSE'),
  ('FINNIFTY','BAJAJFINSV','NSE'),('FINNIFTY','HDFCLIFE','NSE'),('FINNIFTY','SBILIFE','NSE'),
  ('FINNIFTY','SHRIRAMFIN','NSE'),('FINNIFTY','ICICIGI','NSE'),('FINNIFTY','ICICIPRULI','NSE'),
  ('FINNIFTY','HDFCAMC','NSE'),('FINNIFTY','CHOLAFIN','NSE'),('FINNIFTY','MUTHOOTFIN','NSE')
ON CONFLICT (index_key, symbol) DO NOTHING;

INSERT INTO public.market_stocks (symbol, exchange, company_name, sector, is_active, in_universe)
SELECT DISTINCT m.symbol, m.exchange,
  m.symbol AS company_name,
  CASE
    WHEN m.symbol IN ('HDFCBANK','ICICIBANK','SBIN','KOTAKBANK','AXISBANK','INDUSINDBK','BANKBARODA','PNB','FEDERALBNK','IDFCFIRSTB','AUBANK','BANDHANBNK','BAJFINANCE','BAJAJFINSV','HDFCLIFE','SBILIFE','SHRIRAMFIN','ICICIGI','ICICIPRULI','HDFCAMC','CHOLAFIN','MUTHOOTFIN') THEN 'Financials'
    WHEN m.symbol IN ('INFY','TCS','HCLTECH','WIPRO','TECHM','LTIM') THEN 'Information Technology'
    WHEN m.symbol IN ('RELIANCE','ONGC','BPCL','COALINDIA','NTPC','POWERGRID') THEN 'Energy'
    WHEN m.symbol IN ('SUNPHARMA','DRREDDY','CIPLA','DIVISLAB','APOLLOHOSP') THEN 'Healthcare'
    WHEN m.symbol IN ('MARUTI','M&M','TATAMOTORS','EICHERMOT','BAJAJ-AUTO','HEROMOTOCO') THEN 'Consumer Discretionary'
    WHEN m.symbol IN ('HINDUNILVR','ITC','NESTLEIND','BRITANNIA','TATACONSUM','ASIANPAINT','TITAN') THEN 'Consumer Staples'
    WHEN m.symbol IN ('LT','ULTRACEMCO','GRASIM','ADANIPORTS','ADANIENT') THEN 'Industrials'
    WHEN m.symbol IN ('JSWSTEEL','TATASTEEL','HINDALCO') THEN 'Materials'
    WHEN m.symbol IN ('BHARTIARTL') THEN 'Communication Services'
    ELSE 'Diversified'
  END AS sector,
  true, true
FROM public.market_index_members m
LEFT JOIN public.market_stocks s ON s.symbol = m.symbol AND s.exchange = m.exchange
WHERE s.symbol IS NULL;
