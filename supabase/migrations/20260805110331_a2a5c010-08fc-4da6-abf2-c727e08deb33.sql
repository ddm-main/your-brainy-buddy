CREATE OR REPLACE FUNCTION public.enforce_penny_exclusion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.penny_excluded THEN
    NEW.in_universe := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS market_stocks_enforce_penny_exclusion ON public.market_stocks;
CREATE TRIGGER market_stocks_enforce_penny_exclusion
  BEFORE INSERT OR UPDATE ON public.market_stocks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_penny_exclusion();