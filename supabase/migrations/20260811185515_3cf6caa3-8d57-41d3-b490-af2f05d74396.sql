-- 1) Index rows can exist (charts) but are never universe members.
CREATE OR REPLACE FUNCTION public.enforce_penny_exclusion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Benchmarks bypass every equity rule, but never join the tradable universe.
  IF COALESCE(NEW.instrument_type, 'EQ') = 'INDEX' THEN
    NEW.in_universe := false;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM public.market_excluded_symbols e
      WHERE e.symbol = NEW.symbol AND e.exchange = NEW.exchange
    ) THEN
      RETURN NULL;
    END IF;

    IF public.market_is_non_equity(NEW.series, NEW.symbol, NEW.company_name, NEW.instrument_type) THEN
      INSERT INTO public.market_excluded_symbols (symbol, exchange, reason, company_name, series)
      VALUES (NEW.symbol, NEW.exchange,
              CASE WHEN upper(COALESCE(NEW.series,'')) IN ('SM','ST') THEN 'sme'
                   WHEN upper(COALESCE(NEW.series,'')) IN ('BE','BZ') THEN 'series'
                   ELSE 'etf' END,
              NEW.company_name, NEW.series)
      ON CONFLICT (symbol, exchange) DO NOTHING;
      RETURN NULL;
    END IF;

    IF NEW.market_cap IS NOT NULL AND NEW.market_cap < 1000 THEN
      INSERT INTO public.market_excluded_symbols (symbol, exchange, reason, company_name, series, market_cap)
      VALUES (NEW.symbol, NEW.exchange, 'cap<1000cr', NEW.company_name, NEW.series, NEW.market_cap)
      ON CONFLICT (symbol, exchange) DO NOTHING;
      RETURN NULL;
    END IF;

    IF NEW.market_cap IS NULL THEN
      NEW.in_universe := false;
    END IF;
  END IF;

  IF COALESCE(NEW.penny_excluded, false) THEN
    NEW.in_universe := false;
  END IF;
  RETURN NEW;
END;
$function$;

-- 2) The universe surface reads the gate column.
CREATE OR REPLACE VIEW public.market_universe AS
  SELECT id, symbol, exchange, token, company_name, sector, industry, series, lot_size, isin,
         face_value, tick_size, instrument_type, is_active, created_at, updated_at, in_universe,
         yahoo_symbol, last_price_sync_at, market_cap, pe_ttm, roe, next_earnings_at, is_nifty500,
         last_fundamentals_sync_at, price_sync_attempts, price_sync_attempts_day, fno_enabled,
         sub_sector, sub_sector_source, total_shares_cr, free_float_cr, shares_source, shares_as_of,
         market_cap_calc_at, market_cap_source, market_cap_as_of, tickertape_sid, tickertape_sid_as_of,
         kotak_segment, history_backfill_attempts, history_backfill_attempted_at, history_backfill_error,
         shares_sync_attempts, shares_sync_attempted_at, token_missing_at, penny_excluded, penny_reason,
         penny_checked_at, price_data_missing_at
    FROM public.market_stocks
   WHERE COALESCE(is_active, true) IS TRUE
     AND in_universe IS TRUE
     AND COALESCE(instrument_type, 'EQ') <> 'INDEX';

-- 3) Symbol pickers switch to the single gate.
CREATE OR REPLACE FUNCTION public.claim_market_fundamentals_sync(_limit integer DEFAULT 40)
 RETURNS TABLE(symbol text, exchange text, company_name text, yahoo_symbol text, queue_priority integer, last_attempted_at timestamp with time zone, last_fundamentals_sync_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT
      s.ctid,
      s.symbol,
      s.exchange,
      s.company_name,
      s.yahoo_symbol,
      s.last_fundamentals_sync_at,
      f.last_attempted_at,
      CASE
        WHEN f.symbol IS NULL THEN 0
        WHEN f.sync_status = 'failed'
          AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '12 hours' THEN 1
        WHEN f.sync_status = 'partial'
          AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '24 hours' THEN 2
        WHEN COALESCE(f.updated_at, f.data_as_of, f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '1 day' THEN 3
        ELSE 9
      END AS queue_priority
    FROM public.market_stocks s
    LEFT JOIN public.market_fundamentals_global f
      ON f.symbol = s.symbol AND f.exchange = s.exchange
    WHERE s.is_active = true
      AND s.in_universe IS TRUE
      AND (
        f.symbol IS NULL
        OR (
          f.sync_status = 'failed'
          AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '12 hours'
        )
        OR (
          f.sync_status = 'partial'
          AND COALESCE(f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '24 hours'
        )
        OR COALESCE(f.updated_at, f.data_as_of, f.last_attempted_at, '1970-01-01'::timestamptz) < now() - interval '1 day'
      )
    ORDER BY queue_priority ASC, f.last_attempted_at ASC NULLS FIRST, s.last_fundamentals_sync_at ASC NULLS FIRST, s.symbol ASC
    LIMIT GREATEST(1, LEAST(_limit, 200))
    FOR UPDATE OF s SKIP LOCKED
  ), claimed AS (
    UPDATE public.market_stocks s
       SET last_fundamentals_sync_at = now()
      FROM candidates c
     WHERE s.ctid = c.ctid
     RETURNING s.symbol, s.exchange, s.company_name, s.yahoo_symbol, c.queue_priority, c.last_attempted_at, s.last_fundamentals_sync_at
  )
  SELECT claimed.symbol, claimed.exchange, claimed.company_name, claimed.yahoo_symbol,
         claimed.queue_priority, claimed.last_attempted_at, claimed.last_fundamentals_sync_at
  FROM claimed;
END;
$function$;

CREATE OR REPLACE FUNCTION public.market_history_backfill_candidates(_limit integer DEFAULT 40, _min_bars integer DEFAULT 750)
 RETURNS TABLE(symbol text, exchange text, yahoo_symbol text, bars integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH cfg AS (
    SELECT
      COALESCE(MAX(days) FILTER (WHERE key = 'prices_hot_tracked'), 500) AS hot_tracked,
      COALESCE(MAX(days) FILTER (WHERE key = 'prices_hot_other'), 260)   AS hot_other
    FROM public.system_retention_config
  ), tracked AS (
    SELECT DISTINCT s FROM (
      SELECT symbol s FROM public.market_watchlist_items
      UNION SELECT symbol FROM public.market_holdings
      UNION SELECT symbol FROM public.market_positions
      UNION SELECT symbol FROM public.market_index_members
    ) x
  )
  SELECT s.symbol,
         s.exchange,
         s.yahoo_symbol,
         COALESCE(d.bars, 0)::int AS bars
  FROM public.market_stocks s
  CROSS JOIN cfg
  LEFT JOIN tracked t ON t.s = s.symbol
  LEFT JOIN (
    SELECT p.symbol, p.exchange, COUNT(*)::int AS bars
    FROM public.market_daily_prices p
    GROUP BY p.symbol, p.exchange
  ) d ON d.symbol = s.symbol AND d.exchange = s.exchange
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND s.in_universe IS TRUE
    AND NOT EXISTS (
      SELECT 1 FROM public.market_archive_index a
      WHERE a.symbol = s.symbol AND a.exchange = s.exchange
    )
    AND COALESCE(d.bars, 0) < LEAST(
          GREATEST(30, _min_bars),
          (CASE WHEN t.s IS NOT NULL THEN cfg.hot_tracked ELSE cfg.hot_other END * 0.68)::int
        )
    AND (
      COALESCE(s.history_backfill_attempts, 0) < 5
      OR COALESCE(s.history_backfill_attempted_at, '1970-01-01'::timestamptz) < now() - interval '7 days'
    )
  ORDER BY s.history_backfill_attempted_at ASC NULLS FIRST,
           COALESCE(d.bars, 0) ASC,
           s.symbol ASC
  LIMIT GREATEST(1, LEAST(_limit, 200))
$function$;

CREATE OR REPLACE FUNCTION public.market_live_sweep_universe()
 RETURNS TABLE(symbol text, yahoo_symbol text, series text, total_shares_cr numeric, token text, kotak_segment text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH slugs AS (
    SELECT DISTINCT CASE upper(regexp_replace(coalesce(w.constituents_slug,''), '[^a-zA-Z0-9]', '', 'g'))
      WHEN 'NIFTYBANK' THEN 'BANKNIFTY'
      ELSE upper(regexp_replace(coalesce(w.constituents_slug,''), '[^a-zA-Z0-9]', '', 'g'))
    END AS key
    FROM public.market_index_watch w
    WHERE coalesce(w.constituents_slug,'') <> ''
  ), watched AS (
    SELECT DISTINCT upper(s) AS symbol FROM (
      SELECT symbol AS s FROM public.market_watchlist_items
      UNION ALL SELECT symbol FROM public.market_holdings WHERE quantity > 0
      UNION ALL SELECT symbol FROM public.market_positions WHERE closed_at IS NULL
      UNION ALL SELECT symbol FROM public.market_gtt_orders WHERE status IN ('pending','active','armed')
      UNION ALL SELECT symbol FROM public.market_alerts WHERE is_active
      UNION ALL SELECT symbol FROM public.market_autotrade_rules WHERE is_armed AND symbol IS NOT NULL
      UNION ALL SELECT m.symbol FROM public.market_index_members m JOIN slugs g ON g.key = upper(m.index_key)
    ) t WHERE s IS NOT NULL AND length(s) > 0
  )
  SELECT s.symbol, s.yahoo_symbol, s.series, s.total_shares_cr, s.token, s.kotak_segment
  FROM public.market_stocks s
  LEFT JOIN watched w ON w.symbol = upper(s.symbol)
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND s.instrument_type = 'EQ'
    AND s.in_universe IS TRUE
  ORDER BY (w.symbol IS NULL), s.symbol;
$function$;

CREATE OR REPLACE FUNCTION public.market_score_backfill_candidates(_limit integer DEFAULT 25, _min_rows integer DEFAULT 100)
 RETURNS TABLE(symbol text, exchange text, market_cap numeric, sector text, bars integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT s.symbol, s.exchange, s.market_cap::numeric, s.sector,
         (SELECT count(*)::int FROM public.market_daily_prices p
           WHERE p.symbol = s.symbol AND p.exchange = s.exchange) AS bars
  FROM public.market_stocks s
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND s.in_universe IS TRUE
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
  SELECT s.symbol, s.exchange, s.market_cap::numeric, s.sector,
         (SELECT count(*)::int FROM public.market_daily_prices p
           WHERE p.symbol = s.symbol AND p.exchange = s.exchange) AS bars
  FROM public.market_stocks s
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND s.in_universe IS TRUE
    AND (SELECT count(*) FROM public.market_score_history h
          WHERE h.symbol = s.symbol AND h.exchange = s.exchange
            AND h.model = 'breakout_v4') < GREATEST(1, _min_rows)
    AND (SELECT count(*) FROM public.market_daily_prices p
          WHERE p.symbol = s.symbol AND p.exchange = s.exchange) >= GREATEST(30, _min_bars)
  ORDER BY s.symbol
  LIMIT GREATEST(1, LEAST(_limit, 200))
$function$;