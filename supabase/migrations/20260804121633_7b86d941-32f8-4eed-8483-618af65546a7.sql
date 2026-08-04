SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname IN ('market-live-sweep-5m','market-live-sweep-preopen','market-live-sweep-postclose');

SELECT cron.schedule('market-live-sweep-preopen', '40 3 * * 1-5', $$SELECT public.market_cron_call('market-live-sweep');$$);
SELECT cron.schedule('market-live-sweep-5m', '*/5 3-9 * * 1-5', $$SELECT public.market_cron_call('market-live-sweep');$$);
SELECT cron.schedule('market-live-sweep-postclose', '5 10 * * 1-5', $$SELECT public.market_cron_call('market-live-sweep');$$);