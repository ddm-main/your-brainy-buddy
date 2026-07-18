
CREATE TABLE public.market_index_watch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  name text NOT NULL,
  region text NOT NULL CHECK (region IN ('IN','GLOBAL')),
  nse_symbol text,
  fno_enabled boolean NOT NULL DEFAULT false,
  constituents_slug text,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_index_watch TO authenticated;
GRANT ALL ON public.market_index_watch TO service_role;

ALTER TABLE public.market_index_watch ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own rows" ON public.market_index_watch
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_market_index_watch_updated_at
  BEFORE UPDATE ON public.market_index_watch
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto sort_order on insert
CREATE OR REPLACE FUNCTION public.market_index_watch_set_sort()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.sort_order IS NULL OR NEW.sort_order = 0 THEN
    NEW.sort_order := COALESCE(
      (SELECT MAX(sort_order) + 1 FROM public.market_index_watch WHERE user_id = NEW.user_id),
      0
    );
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_market_index_watch_set_sort
  BEFORE INSERT ON public.market_index_watch
  FOR EACH ROW EXECUTE FUNCTION public.market_index_watch_set_sort();

-- Re-pack sort_order after delete
CREATE OR REPLACE FUNCTION public.market_index_watch_repack()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, created_at) - 1 AS rn
    FROM public.market_index_watch WHERE user_id = OLD.user_id
  )
  UPDATE public.market_index_watch m
     SET sort_order = r.rn
    FROM ranked r
   WHERE m.id = r.id AND m.sort_order <> r.rn;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_market_index_watch_repack
  AFTER DELETE ON public.market_index_watch
  FOR EACH ROW EXECUTE FUNCTION public.market_index_watch_repack();

-- Seed defaults for every existing user
CREATE OR REPLACE FUNCTION public.seed_default_indices(_uid uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.market_index_watch (user_id, symbol, name, region, nse_symbol, fno_enabled, constituents_slug, sort_order)
  VALUES
    (_uid, '^NSEI',                'Nifty 50',     'IN', 'NIFTY',      true,  'nifty50',        1),
    (_uid, '^BSESN',               'Sensex',       'IN', NULL,         false, NULL,             2),
    (_uid, '^NSEBANK',             'Bank Nifty',   'IN', 'BANKNIFTY',  true,  'niftybank',      3),
    (_uid, 'NIFTY_MIDCAP_100.NS',  'Midcap 100',   'IN', NULL,         false, 'niftymidcap100', 4),
    (_uid, '^CNXSC',               'Smallcap',     'IN', NULL,         false, NULL,             5),
    (_uid, '^INDIAVIX',            'India VIX',    'IN', NULL,         false, NULL,             6)
  ON CONFLICT (user_id, symbol) DO NOTHING;
$$;

SELECT public.seed_default_indices(id) FROM auth.users;
