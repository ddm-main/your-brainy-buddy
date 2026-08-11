-- 1. Permanent exclusion list -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_excluded_symbols (
  symbol text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  reason text NOT NULL,
  company_name text,
  series text,
  market_cap numeric,
  last_close numeric,
  excluded_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, exchange)
);

GRANT SELECT ON public.market_excluded_symbols TO authenticated;
GRANT ALL ON public.market_excluded_symbols TO service_role;

ALTER TABLE public.market_excluded_symbols ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read excluded symbols"
ON public.market_excluded_symbols
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS market_excluded_symbols_symbol_idx
  ON public.market_excluded_symbols (symbol);

-- 2. Non-equity classifier -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_is_non_equity(
  _series text, _symbol text, _company_name text, _instrument_type text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN COALESCE(_instrument_type, 'EQ') = 'INDEX' THEN false
    WHEN upper(COALESCE(_series, '')) IN ('SM', 'ST', 'BE', 'BZ') THEN true
    WHEN upper(COALESCE(_symbol, '')) ~ '(BEES|ETF|IETF|LIQUIDCASE|GOLDCASE)$' THEN true
    WHEN COALESCE(_company_name, '') ~* '(exchange traded|etf|mutual fund|index fund|liquid fund)' THEN true
    ELSE false
  END;
$$;

-- 3. Purge helper --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_purge_symbols(_symbols text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  t text;
  n int := 0;
  c int;
  tables text[] := ARRAY[
    'market_daily_prices','market_intraday_prices','market_live_prices',
    'market_live_price_stage','market_eod_nse','market_quotes',
    'market_indicators_cache','market_stock_scores','market_score_history',
    'market_fundamentals','market_fundamentals_global','market_shares_outstanding',
    'market_news','market_stock_ai','market_breakout_tracker',
    'market_breakout_snapshots','market_screener_snapshot','market_nse_master'
  ];
BEGIN
  IF _symbols IS NULL OR array_length(_symbols, 1) IS NULL THEN RETURN 0; END IF;
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DELETE FROM public.%I WHERE symbol = ANY($1)', t) USING _symbols;
    GET DIAGNOSTICS c = ROW_COUNT;
    n := n + c;
  END LOOP;
  RETURN n;
END;
$$;

-- 4. Ingest guard: reject excluded + non-equity rows ---------------------------
CREATE OR REPLACE FUNCTION public.enforce_penny_exclusion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Benchmarks bypass every equity rule.
  IF COALESCE(NEW.instrument_type, 'EQ') = 'INDEX' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Permanently excluded: never re-create the row.
    IF EXISTS (
      SELECT 1 FROM public.market_excluded_symbols e
      WHERE e.symbol = NEW.symbol AND e.exchange = NEW.exchange
    ) THEN
      RETURN NULL;
    END IF;

    -- Non-equity scrip (SME/ST/BE/BZ series, ETFs, funds): out of the universe
    -- for good, recorded so the listing refresh cannot bring it back.
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

    -- No cap yet: admitted, but out of the universe until a scan proves it.
    IF NEW.market_cap IS NULL THEN
      NEW.in_universe := false;
    END IF;
  END IF;

  IF COALESCE(NEW.penny_excluded, false) THEN
    NEW.in_universe := false;
  END IF;
  RETURN NEW;
END;
$$;

-- 5. Derived-write guard now keyed on the exclusion list -----------------------
CREATE OR REPLACE FUNCTION public.block_penny_rows()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  sym text := j->>'symbol';
  exch text := j->>'exchange';
BEGIN
  IF sym IS NULL THEN RETURN NEW; END IF;

  IF EXISTS (
    SELECT 1 FROM public.market_excluded_symbols e
    WHERE e.symbol = sym AND (exch IS NULL OR e.exchange = exch)
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.market_stocks s
    WHERE s.symbol = sym AND (exch IS NULL OR s.exchange = exch)
      AND s.penny_excluded IS TRUE
  ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

-- 6. Monthly sweep: delete + blocklist instead of flag -------------------------
CREATE OR REPLACE FUNCTION public.market_penny_sweep(
  _min_cap_cr numeric DEFAULT 1000, _min_price numeric DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _trade_date date;
  _floor_date date;
  _removed int := 0;
  _purged int := 0;
  _universe int := 0;
  _evaluated int := 0;
  _cap_derived int := 0;
  _snapshot int := NULL;
  _snapshot_error text := NULL;
  _started timestamptz := now();
  _syms text[];
  _by_reason jsonb;
BEGIN
  SELECT max(trade_date) INTO _trade_date FROM public.market_daily_prices;
  IF _trade_date IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no settled prices');
  END IF;

  SELECT min(d) INTO _floor_date FROM (
    SELECT DISTINCT trade_date AS d FROM public.market_daily_prices
    WHERE trade_date <= _trade_date ORDER BY 1 DESC LIMIT 10
  ) x;

  CREATE TEMP TABLE _penny_eval ON COMMIT DROP AS
  WITH last_px AS (
    SELECT DISTINCT ON (p.symbol) p.symbol, p.close
    FROM public.market_daily_prices p
    WHERE p.trade_date >= _floor_date AND p.close IS NOT NULL
    ORDER BY p.symbol, p.trade_date DESC
  ), base AS (
    SELECT s.symbol, s.exchange, s.company_name, s.series, s.is_active,
           lp.close AS last_close,
           -- Fallback cap: shares outstanding (cr) x last close, in ₹ crores.
           COALESCE(s.market_cap,
                    CASE WHEN s.total_shares_cr IS NOT NULL AND lp.close IS NOT NULL
                         THEN s.total_shares_cr * lp.close END) AS cap,
           (s.market_cap IS NULL) AS cap_missing,
           COALESCE(s.shares_sync_attempts, 0) AS shares_attempts,
           public.market_is_non_equity(s.series, s.symbol, s.company_name, s.instrument_type) AS non_equity
    FROM public.market_stocks s
    LEFT JOIN last_px lp ON lp.symbol = s.symbol
    WHERE COALESCE(s.instrument_type, 'EQ') <> 'INDEX'
  )
  SELECT b.*,
         CASE
           WHEN NOT b.is_active THEN 'inactive'
           WHEN b.non_equity THEN 'non_equity'
           WHEN b.cap IS NOT NULL AND b.cap < _min_cap_cr THEN 'cap<' || _min_cap_cr::int || 'cr'
           WHEN b.last_close IS NOT NULL AND b.last_close < _min_price THEN 'ltp<' || _min_price::int
           WHEN b.cap IS NULL AND b.shares_attempts >= 2 THEN 'no_market_cap'
           ELSE NULL
         END AS reason
  FROM base b;

  SELECT count(*), count(*) FILTER (WHERE cap_missing AND cap IS NOT NULL)
    INTO _evaluated, _cap_derived FROM _penny_eval;

  -- Persist derived caps so the rest of the app sees them.
  UPDATE public.market_stocks s
     SET market_cap = e.cap,
         market_cap_source = COALESCE(s.market_cap_source, 'derived_shares_x_close'),
         market_cap_calc_at = now(),
         updated_at = now()
    FROM _penny_eval e
   WHERE e.symbol = s.symbol AND e.exchange = s.exchange
     AND e.cap_missing AND e.cap IS NOT NULL;

  SELECT array_agg(DISTINCT symbol) INTO _syms FROM _penny_eval WHERE reason IS NOT NULL;
  SELECT jsonb_object_agg(reason, n) INTO _by_reason
  FROM (SELECT reason, count(*) n FROM _penny_eval WHERE reason IS NOT NULL GROUP BY 1) q;

  INSERT INTO public.market_excluded_symbols (symbol, exchange, reason, company_name, series, market_cap, last_close)
  SELECT e.symbol, e.exchange, e.reason, e.company_name, e.series, e.cap, e.last_close
  FROM _penny_eval e WHERE e.reason IS NOT NULL
  ON CONFLICT (symbol, exchange) DO NOTHING;

  DELETE FROM public.market_stocks s
   USING _penny_eval e
   WHERE e.reason IS NOT NULL AND e.symbol = s.symbol AND e.exchange = s.exchange;
  GET DIAGNOSTICS _removed = ROW_COUNT;

  _purged := public.market_purge_symbols(_syms);

  -- Survivors are the universe.
  UPDATE public.market_stocks s
     SET penny_excluded = false,
         penny_reason = NULL,
         penny_checked_at = now(),
         in_universe = COALESCE(s.is_active, true),
         updated_at = now()
   WHERE COALESCE(s.instrument_type, 'EQ') <> 'INDEX';

  SELECT count(*) INTO _universe FROM public.market_stocks
   WHERE in_universe IS TRUE AND COALESCE(instrument_type,'EQ') <> 'INDEX';

  BEGIN
    SELECT public.refresh_market_screener_snapshot() INTO _snapshot;
  EXCEPTION WHEN OTHERS THEN
    _snapshot_error := SQLERRM;
  END;

  INSERT INTO public.system_maintenance_log (task, status, details)
  VALUES ('market_penny_sweep', 'ok',
          jsonb_build_object('removed', _removed, 'purged_rows', _purged,
                             'universe', _universe, 'by_reason', COALESCE(_by_reason, '{}'::jsonb)));

  RETURN jsonb_build_object(
    'ok', true,
    'trade_date', _trade_date,
    'evaluated', _evaluated,
    'cap_derived', _cap_derived,
    'removed', _removed,
    'by_reason', COALESCE(_by_reason, '{}'::jsonb),
    'purged_rows', _purged,
    'universe', _universe,
    'snapshot_rows', _snapshot,
    'snapshot_error', _snapshot_error,
    'took_ms', (extract(epoch FROM now() - _started) * 1000)::int
  );
END;
$$;