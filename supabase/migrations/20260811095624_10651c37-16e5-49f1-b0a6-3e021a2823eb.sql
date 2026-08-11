create or replace function public.market_live_sweep_universe()
returns table(symbol text, yahoo_symbol text, series text, total_shares_cr numeric, token text, kotak_segment text)
language sql
stable
security definer
set search_path to 'public'
as $$
  with slugs as (
    select distinct case upper(regexp_replace(coalesce(w.constituents_slug,''), '[^a-zA-Z0-9]', '', 'g'))
             when 'NIFTYBANK' then 'BANKNIFTY'
             else upper(regexp_replace(coalesce(w.constituents_slug,''), '[^a-zA-Z0-9]', '', 'g'))
           end as key
    from public.market_index_watch w
    where coalesce(w.constituents_slug,'') <> ''
  ),
  watched as (
    select distinct upper(s) as symbol from (
      select symbol as s from public.market_watchlist_items
      union all select symbol from public.market_holdings where quantity > 0
      union all select symbol from public.market_positions where closed_at is null
      union all select symbol from public.market_gtt_orders where status in ('pending','active','armed')
      union all select symbol from public.market_alerts where is_active
      union all select symbol from public.market_autotrade_rules where is_armed and symbol is not null
      union all select m.symbol from public.market_index_members m
        join slugs g on g.key = upper(m.index_key)
    ) t where s is not null and length(s) > 0
  )
  select u.symbol, u.yahoo_symbol, u.series, u.total_shares_cr, u.token, u.kotak_segment
  from public.market_universe u
  left join watched w on w.symbol = upper(u.symbol)
  where u.exchange = 'NSE'
    and u.instrument_type = 'EQ'
    and coalesce(u.series, 'EQ') not in ('SM','ST')
  order by (w.symbol is null), u.symbol;
$$;

grant execute on function public.market_live_sweep_universe() to service_role;