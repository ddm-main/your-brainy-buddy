-- market_eod_nse's primary key was (symbol, trade_date) with no exchange
-- column at all — NSE and BSE bhavcopy rows shared a conflict key by
-- coincidence of symbol format (BSE uses numeric SC_CODE, NSE uses alpha
-- tickers), not by design. Any future symbol-format change on either side
-- would silently overwrite/misattribute rows across exchanges.
ALTER TABLE public.market_eod_nse ADD COLUMN exchange text NOT NULL DEFAULT 'NSE';
UPDATE public.market_eod_nse SET exchange = 'BSE' WHERE source = 'bse_bhavcopy';

ALTER TABLE public.market_eod_nse DROP CONSTRAINT market_eod_nse_pkey;
ALTER TABLE public.market_eod_nse ADD PRIMARY KEY (symbol, exchange, trade_date);
