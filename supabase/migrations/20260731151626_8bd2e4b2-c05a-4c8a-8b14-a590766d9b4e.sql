-- IST = UTC+5:30. Post-open 09:45 IST = 04:15 UTC, midday 13:00 IST = 07:30 UTC,
-- post-close 15:45 IST = 10:15 UTC. Weekdays only.
select cron.unschedule(jobname) from cron.job
 where jobname in ('market-funds-sync','market-funds-sync-mid','market-funds-sync-post',
                   'market-sync-holdings','market-sync-holdings-post',
                   'market-sync-positions','market-sync-positions-mid','market-sync-positions-post');

select cron.schedule('market-funds-sync',      '15 4 * * 1-5', $$select public.market_cron_call('market-funds')$$);
select cron.schedule('market-funds-sync-mid',  '30 7 * * 1-5', $$select public.market_cron_call('market-funds')$$);
select cron.schedule('market-funds-sync-post', '15 10 * * 1-5', $$select public.market_cron_call('market-funds')$$);

select cron.schedule('market-sync-holdings',      '20 4 * * 1-5', $$select public.market_cron_call('market-sync-holdings')$$);
select cron.schedule('market-sync-holdings-post', '20 10 * * 1-5', $$select public.market_cron_call('market-sync-holdings')$$);

select cron.schedule('market-sync-positions',      '25 4 * * 1-5', $$select public.market_cron_call('market-sync-positions')$$);
select cron.schedule('market-sync-positions-mid',  '35 7 * * 1-5', $$select public.market_cron_call('market-sync-positions')$$);
select cron.schedule('market-sync-positions-post', '25 10 * * 1-5', $$select public.market_cron_call('market-sync-positions')$$);