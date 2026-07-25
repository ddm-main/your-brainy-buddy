
DO $$ BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.market_watchlists; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.market_watchlist_items; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

ALTER TABLE public.market_watchlists REPLICA IDENTITY FULL;
ALTER TABLE public.market_watchlist_items REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_market_watchlist_items_order
  ON public.market_watchlist_items (watchlist_id, priority DESC, created_at ASC);
