-- 1. Retention key for the absolute ceiling
INSERT INTO public.system_retention_config (key, days, note)
VALUES ('max_history_days', 730, 'hard ceiling: nothing older than 2 years is kept')
ON CONFLICT (key) DO UPDATE SET days = 730, note = excluded.note, updated_at = now();

-- 2. Hard 2-year ceiling. Runs after the shorter per-table windows and only
-- catches what they miss (gaps, pre-retention history, one-off imports).
CREATE OR REPLACE FUNCTION public.prune_beyond_history_ceiling()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  keep_days integer;
  cutoff date;
  cutoff_ts timestamptz;
  res jsonb := '{}'::jsonb;
  total integer := 0;
  n integer;
  t text; col text; i integer;
  date_targets text[][] := ARRAY[
    ['market_daily_prices','trade_date'],
    ['market_eod_nse','trade_date'],
    ['market_score_history','trade_date'],
    ['market_score_distribution','trade_date'],
    ['market_breadth_daily','trade_date'],
    ['market_sector_strength_daily','trade_date'],
    ['market_realized_pnl_daily','day'],
    ['nav_history','nav_date']
  ];
  ts_targets text[][] := ARRAY[
    ['market_intraday_prices','ts'],
    ['market_indicators_cache','computed_at'],
    ['market_breakout_snapshots','computed_at'],
    ['market_news','created_at'],
    ['market_provider_observations','created_at'],
    ['market_value_audit','checked_at'],
    ['market_ingestion_runs','started_at'],
    ['market_option_chain_snapshots','captured_at']
  ];
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can run maintenance';
  END IF;

  SELECT COALESCE(MAX(days), 730) INTO keep_days
  FROM public.system_retention_config WHERE key = 'max_history_days';
  keep_days := GREATEST(90, keep_days);
  cutoff := (current_date - keep_days)::date;
  cutoff_ts := (current_date - keep_days)::timestamptz;

  FOR i IN 1 .. array_length(date_targets, 1) LOOP
    t := date_targets[i][1]; col := date_targets[i][2];
    n := public.prune_batched(format(
      'DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I WHERE %I < %L::date LIMIT 50000)',
      t, t, col, cutoff));
    IF n > 0 THEN res := res || jsonb_build_object(t, n); total := total + n; END IF;
  END LOOP;

  FOR i IN 1 .. array_length(ts_targets, 1) LOOP
    t := ts_targets[i][1]; col := ts_targets[i][2];
    n := public.prune_batched(format(
      'DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I WHERE %I < %L::timestamptz LIMIT 50000)',
      t, t, col, cutoff_ts));
    IF n > 0 THEN res := res || jsonb_build_object(t, n); total := total + n; END IF;
  END LOOP;

  -- Archives whose whole window predates the ceiling, or that belong to a
  -- penny name, are dead weight. Index rows go now; the storage objects are
  -- swept by market-archive-prices (mode: prune), which reads this list.
  SELECT count(*)::int INTO n
  FROM public.market_archive_index a
  LEFT JOIN public.market_stocks s ON s.symbol = a.symbol AND s.exchange = a.exchange
  WHERE a.last_date < cutoff OR COALESCE(s.penny_excluded, false) = true;
  res := res || jsonb_build_object('archives_expired', COALESCE(n, 0));

  INSERT INTO public.system_maintenance_log (action, details)
  VALUES ('history_ceiling', res || jsonb_build_object('cutoff', cutoff, 'keep_days', keep_days, 'rows_deleted', total));

  RETURN res || jsonb_build_object('cutoff', cutoff, 'keep_days', keep_days, 'rows_deleted', total);
END;
$function$;

-- 3. Keep penny names out of the archive and score-backfill candidate lists.
CREATE OR REPLACE FUNCTION public.market_archive_candidates(_limit integer DEFAULT 40, _hot_tracked integer DEFAULT 730, _hot_other integer DEFAULT 400)
RETURNS TABLE(symbol text, exchange text, cutoff date, cold_bars integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH tracked AS (
    SELECT DISTINCT s FROM (
      SELECT symbol s FROM public.market_watchlist_items
      UNION SELECT symbol FROM public.market_holdings
      UNION SELECT symbol FROM public.market_positions
      UNION SELECT symbol FROM public.market_index_members
    ) x
  ), base AS (
    SELECT st.symbol,
           st.exchange,
           (current_date - CASE WHEN t.s IS NOT NULL
                                THEN GREATEST(180, _hot_tracked)
                                ELSE GREATEST(120, _hot_other) END)::date AS cutoff,
           a.updated_at AS archived_at
    FROM public.market_stocks st
    LEFT JOIN tracked t ON t.s = st.symbol
    LEFT JOIN public.market_archive_index a
           ON a.symbol = st.symbol AND a.exchange = st.exchange
    WHERE st.is_active = true
      AND st.exchange = 'NSE'
      AND COALESCE(st.penny_excluded, false) = false
  )
  SELECT b.symbol, b.exchange, b.cutoff, 0::int
  FROM base b
  WHERE EXISTS (
    SELECT 1 FROM public.market_daily_prices p
    WHERE p.symbol = b.symbol
      AND p.exchange = b.exchange
      AND p.trade_date < b.cutoff
  )
  ORDER BY b.archived_at ASC NULLS FIRST, b.symbol ASC
  LIMIT GREATEST(1, LEAST(_limit, 200))
$function$;

CREATE OR REPLACE FUNCTION public.market_score_backfill_candidates(_limit integer DEFAULT 25, _min_rows integer DEFAULT 100)
RETURNS TABLE(symbol text, exchange text, market_cap numeric, sector text, bars integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT s.symbol,
         s.exchange,
         s.market_cap::numeric,
         s.sector,
         (SELECT count(*)::int FROM public.market_daily_prices p
           WHERE p.symbol = s.symbol AND p.exchange = s.exchange) AS bars
  FROM public.market_stocks s
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND COALESCE(s.penny_excluded, false) = false
    AND (SELECT count(*) FROM public.market_score_history h
          WHERE h.symbol = s.symbol AND h.exchange = s.exchange
            AND h.model = 'breakout_v4') < GREATEST(1, _min_rows)
    AND (SELECT count(*) FROM public.market_daily_prices p
          WHERE p.symbol = s.symbol AND p.exchange = s.exchange) >= 130
  ORDER BY s.symbol
  LIMIT GREATEST(1, LEAST(_limit, 200))
$function$;

CREATE OR REPLACE FUNCTION public.market_score_backfill_candidates(_limit integer DEFAULT 25, _min_rows integer DEFAULT 100, _min_bars integer DEFAULT 90)
RETURNS TABLE(symbol text, exchange text, market_cap numeric, sector text, bars integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT s.symbol,
         s.exchange,
         s.market_cap::numeric,
         s.sector,
         (SELECT count(*)::int FROM public.market_daily_prices p
           WHERE p.symbol = s.symbol AND p.exchange = s.exchange) AS bars
  FROM public.market_stocks s
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND COALESCE(s.penny_excluded, false) = false
    AND (SELECT count(*) FROM public.market_score_history h
          WHERE h.symbol = s.symbol AND h.exchange = s.exchange
            AND h.model = 'breakout_v4') < GREATEST(1, _min_rows)
    AND (SELECT count(*) FROM public.market_daily_prices p
          WHERE p.symbol = s.symbol AND p.exchange = s.exchange) >= GREATEST(30, _min_bars)
  ORDER BY s.symbol
  LIMIT GREATEST(1, LEAST(_limit, 200))
$function$;