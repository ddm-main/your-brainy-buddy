ALTER TABLE public.market_screener_snapshot SET UNLOGGED;
ALTER TABLE public.market_indicators_cache SET UNLOGGED;
ALTER TABLE public.market_quotes SET UNLOGGED;
ALTER TABLE public.market_intraday_prices SET UNLOGGED;
ALTER TABLE public.market_provider_health SET UNLOGGED;
ALTER TABLE public.market_provider_observations SET UNLOGGED;
ALTER TABLE public.market_ticker_trace SET UNLOGGED;

SELECT cron.alter_job(46, schedule := '*/5 * * * *');