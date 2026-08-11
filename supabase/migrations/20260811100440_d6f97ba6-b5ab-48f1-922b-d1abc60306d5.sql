-- 966 active NSE EQ symbols were flagged penny_excluded with reason
-- 'cap<1000cr' while their market_cap is NULL. Unknown is not "small": this
-- silently removed real names (MATRIMONY ~₹1,250 Cr, ABANSENT) from the
-- screener universe, which is why app results disagreed with Economic Times.
update public.market_stocks s
   set penny_excluded = false,
       penny_reason = null,
       penny_checked_at = now(),
       in_universe = s.is_active
 where s.penny_excluded is true
   and s.market_cap is null
   and coalesce(s.penny_reason, '') like 'cap<%'
   and not exists (
     -- keep genuine sub-₹50 names excluded on the price rule
     select 1 from public.market_daily_prices p
      where p.symbol = s.symbol and p.exchange = s.exchange
        and p.close is not null
        and p.trade_date > current_date - 30
        and p.close < 50
   );

insert into public.system_maintenance_log (mode, rows_deleted, total_deleted, duration_ms)
values ('penny_unknown_cap_reinstate',
        jsonb_build_object('note', 'unknown market cap no longer treated as sub-1000cr'),
        0, 0);