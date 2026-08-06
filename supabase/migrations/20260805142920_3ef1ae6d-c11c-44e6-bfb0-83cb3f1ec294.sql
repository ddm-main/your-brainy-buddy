-- 1. Fast lookup for the flag
CREATE INDEX IF NOT EXISTS market_stocks_penny_excluded_idx
  ON public.market_stocks (symbol) WHERE penny_excluded;

-- 2. Generic penny gate: silently drop writes for flagged symbols.
CREATE OR REPLACE FUNCTION public.block_penny_rows()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  sym text := j->>'symbol';
  exch text := j->>'exchange';
  flagged boolean;
BEGIN
  IF sym IS NULL THEN RETURN NEW; END IF;

  IF exch IS NULL THEN
    SELECT bool_or(s.penny_excluded) INTO flagged
    FROM public.market_stocks s WHERE s.symbol = sym;
  ELSE
    SELECT s.penny_excluded INTO flagged
    FROM public.market_stocks s WHERE s.symbol = sym AND s.exchange = exch;
  END IF;

  IF flagged IS TRUE THEN
    RETURN NULL; -- drop the row, do not error the batch
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Attach to every penny-relevant table
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'market_daily_prices','market_intraday_prices','market_live_prices',
    'market_live_price_stage','market_eod_nse','market_quotes',
    'market_indicators_cache','market_stock_scores','market_score_history',
    'market_fundamentals','market_fundamentals_global','market_shares_outstanding',
    'market_news','market_stock_ai','market_breakout_tracker',
    'market_breakout_snapshots','market_screener_snapshot','market_nse_master'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_block_penny', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.block_penny_rows()',
      t || '_block_penny', t);
  END LOOP;
END $$;

-- 4. Never admit a new penny stock into the universe
CREATE OR REPLACE FUNCTION public.enforce_penny_exclusion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND COALESCE(NEW.penny_excluded, false) = false
     AND NEW.market_cap IS NOT NULL
     AND NEW.market_cap < 1000 THEN
    NEW.penny_excluded := true;
    NEW.penny_reason := 'cap<1000cr';
    NEW.penny_checked_at := now();
  END IF;

  IF NEW.penny_excluded THEN
    NEW.in_universe := false;
  END IF;
  RETURN NEW;
END;
$$;